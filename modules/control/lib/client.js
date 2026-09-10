// dsh-archive-control Client 半部（ DSH 原生风格 + 完整功能页）
//  - 仍整体替换 root 座位（专属界面），但视觉全面改用 DSH 原生主题 token
//    （--dsw-alias-* / --dsw-specific-sidebar-fill / --dsw-font-family 等），
//    随原生浅色/深色主题自动适配，观感与 DSH 原生 UI 一致。
//  - 8 功能页全部升级为可用的管理界面（非 stats 键值对）：
//    总控/人格/思维循环/记忆/自进化/定时任务/通知/识图。
//  - 数据面：connection RPC（session.*）+ control RPC（archive-control）。
window.__ModuleLoader__.load({
  id: 'dsh-archive-control',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    const { useState, useEffect, useLayoutEffect, useCallback, useRef } = React;

    // ---------- 基础工具 ----------
    function e(tag, props, ...children) { return React.createElement(tag, props ?? null, ...children); }
    function truncate(s, n) { const t = String(s ?? ''); const a = [...t]; return a.length > n ? a.slice(0, n - 1).join('') + '…' : t; }
    function fmtTime(ts) { if (!ts) return '—'; const d = new Date(ts); const p = (x) => String(x).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
    function fmtFull(ts) { if (!ts) return '—'; const d = new Date(ts); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
    /** 时长毫秒 → "X小时Y分"（睡眠/冷却剩余显示）。 */
    function fmtDur(ms) {
      const m = Math.floor(Number(ms ?? 0) / 60000);
      if (m <= 0) return '<1分';
      const h = Math.floor(m / 60);
      return h > 0 ? `${h}小时${m % 60 > 0 ? `${m % 60}分` : ''}` : `${m}分钟`;
    }
    /** 睡眠相位摘要文本（总控/思维循环页共用）。 */
    function sleepLabelOf(sl) {
      if (!sl) return '—';
      if (sl.phase === 'asleep') return `😴 睡眠期（已睡 ${fmtDur(sl.asleepForMs)}）`;
      if (sl.phase === 'cooldown') return `⏳ 强制清醒间隔（剩 ${fmtDur(sl.cooldownLeftMs)}）`;
      return '清醒';
    }
    function pct(x) { return `${Math.round(Number(x ?? 0) * 100)}%`; }
    //  性能优化：会话历史尾部初始页条数（60 条约 1.1MB，向上翻页 loadOlder 仍 100 条/次）。
    // 用户可经「↑ 加载更早消息」按钮/滚到顶部逐页上翻直至最早一条（hasMore=false 按钮消失），历史不截断。
    const HISTORY_PAGE = 60;
    //  性能修复：总控记录面板每页条数（服务端按 seq 增量回传，客户端列表也按此上限裁剪）。
    const LED_PAGE = 100;
    /** 事件内容块：assistant/message 的 content 在 data.message.content（嵌套），user/message 在 data.content（直接）——两者都要兼容（ 修复"AI 无应答"根因）。 */
    function blocksOf(ev) {
      const d = ev?.data;
      if (!d) return [];
      if (Array.isArray(d.message?.content)) return d.message.content;
      if (Array.isArray(d.content)) return d.content;
      return [];
    }
    /** 用户状态类工具调用对用户隐藏：状态更新是后台静默行为，聊天界面不展示这些工具调用；
     *  仅当用户明确要求演示状态更新时，AI 会在回复正文中说明（工具 chip 仍不上屏）。 */
    const HIDDEN_STATE_TOOLS = ['user_state_set', 'user_state_clear', 'user_state_get'];
    /**
     * 会话事件 → 消息列表（ 流式/分页改造）：
     * 1) 过滤系统注入上下文（user/message 且 source.kind !== 'user' —— 含 file policy/approval/<time>/<persona>/记忆注入、
     *    skill-catalog 技能目录 <system-reminder> 等，均非真实用户输入，曾整段上屏显示为"你"的消息；仅 kind==='user'
     *    视为真实用户消息，kind==='plugin' 的非注入说明（如人格一致性拦截）保留为系统提示）；
     * 2) assistant/message 聚合为单条复合消息：text=回答 / reasoning=思考过程（折叠区）/ tool=工具调用列表；
     * 3) assistant/chunk 流式增量不在此展开（由 SSE 的 inFlight 流式条目实时展示，历史回放时以 assistant/message 为准）。
     */
    function collectMessages(events, seqMap) {
      const out = [];
      for (const x of events) {
        const ev = x?.event ?? x;
        const blocks = blocksOf(ev);
        if (ev?.type === 'user/message') {
          const txt = blocks.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? `[图片 ${b.name || b.mediaType || ''}]` : '')).filter(Boolean).join('\n');
          //  source.kind 白名单过滤系统注入。skill-catalog（每回合注入的
          // 技能目录 <system-reminder>）曾因不匹配 "Current runtime context" 前缀而被渲染成"你"的
          // 用户气泡（用户输入后弹出大段技能清单）。真实用户消息 source.kind==='user'；runtime-context/
          // skill-catalog 等注入 kind 非 user → 全部跳过，不进入聊天流。
          const kind = ev.data?.source?.kind;
          if (kind === 'user') {
            if (txt) out.push({ role: 'user', text: txt, time: ev.time ?? 0, key: `e${ev.seq}` });
          } else if (kind === 'plugin') {
            //  plugin kind 中非注入的说明（人格一致性拦截说明等）渲染为系统提示，
            // 避免被误认为"你"的用户气泡；runtime-context 注入（"Current runtime context" 开头）跳过。
            if (txt && !txt.startsWith('Current runtime context')) out.push({ role: 'system', text: txt, time: ev.time ?? 0, key: `e${ev.seq}` });
          }
          // 其余 kind（skill-catalog 等系统注入）一律不渲染
        } else if (ev?.type === 'assistant/message') {
          let text = ''; let reasoning = ''; const tools = [];
          for (const b of blocks) {
            if (b?.type === 'text' && b.text) text += b.text;
            else if (b?.type === 'image') text += `\n[图片 ${b.name || b.mediaType || ''}]`;
            else if ((b?.type === 'reasoning' || b?.type === 'thinking') && b.text) reasoning += b.text;
            else if ((b?.type === 'tool-call' || b?.type === 'tool_call') && (b.name || b.toolName)) {
              const tn = String(b.name ?? b.toolName);
              if (!HIDDEN_STATE_TOOLS.includes(tn)) tools.push(tn.slice(0, 80));
            }
          }
          const entry = { role: 'assistant', text, reasoning, tools, time: ev.time ?? 0, key: `e${ev.seq}` };
          //  人格一致性渲染层替换显示：suspicious → 修订版文本 + 角标；blocked → 拦截样式
          const hit = seqMap && seqMap[ev.seq];
          if (hit) {
            if (hit.v === 'suspicious' && hit.r) { entry.text = hit.r; entry.revised = true; }
            else if (hit.v === 'blocked') entry.intercepted = true;
          }
          out.push(entry);
        }
      }
      return out.filter((m) => !(m.role === 'assistant' && !m.text && !m.reasoning && m.tools.length === 0));
    }
    // 会话/工作区标题：仿 DSH 原生——空白会话显示"新会话"；否则优先持久化标题，cwd 尾段，最后 sessionId 短名
    function sessionTitleOf(item) {
      if (!item) return '…';
      if (item.blank === true) return '新会话';
      const t = item.projections?.values?.title;
      if (t) return String(t);
      const cwd = String(item.cwd ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
      if (cwd.length > 0) return cwd[cwd.length - 1];
      return String(item.sessionId ?? '?').slice(0, 16);
    }
    function wsTitleOf(w) {
      if (w?.title) return String(w.title);
      const seg = String(w?.path ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
      return seg.length > 0 ? seg[seg.length - 1] : '工作区';
    }

    // ---------- 消息富文本渲染：markdown-lite + describe-image 引用缩略图 ----------
    // 行内解析：`code` / **bold** / [text](url)（url 仅允许 http(s) 与站内路径，防 javascript: 注入）
    function inlineParts(text) {
      const out = [];
      const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\(([^)\s]+)\))/g;
      let last = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push(text.slice(last, m.index));
        if (m[1]) out.push(e('code', { key: out.length }, m[1].slice(1, -1)));
        else if (m[2]) out.push(e('strong', { key: out.length }, m[2].slice(2, -2)));
        else if (m[3] && /^(https?:|\.?\/)/.test(m[4] || '')) out.push(e('a', { key: out.length, href: m[4], target: '_blank', rel: 'noreferrer' }, m[3].slice(1, -1)));
        else if (m[3]) out.push(m[3]);
        last = m.index + m[0].length;
      }
      if (last < text.length) out.push(text.slice(last));
      return out;
    }
    // 行级渲染：先替换 describe-image 图片引用为缩略图，其余文本再做行内解析
    function renderLine(line) {
      const imgRe = /!\[([^\]]*)\]\((\/describe-image\/raw\/[^)\s]+)\)/g;
      const parts = [];
      let rest = line;
      let m;
      let found = false;
      while ((m = imgRe.exec(rest)) !== null) {
        found = true;
        if (m.index > 0) parts.push(rest.slice(0, m.index));
        parts.push(e('img', { key: parts.length, src: m[2], alt: m[1] || '图片', className: 'arc-msg-img' }));
        rest = rest.slice(m.index + m[0].length);
        imgRe.lastIndex = 0;
      }
      if (!found) return inlineParts(line);
      if (rest) parts.push(rest);
      return parts;
    }
    function renderMessage(text) {
      const lines = String(text).split('\n');
      const nodes = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (/^```/.test(line.trim())) {
          const buf = [];
          i++;
          while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
          i++;
          nodes.push(e('pre', { key: nodes.length }, e('code', null, buf.join('\n'))));
        } else {
          nodes.push(e('p', { key: nodes.length, className: 'arc-msg-p' }, renderLine(line)));
          i++;
        }
      }
      return nodes.length > 0 ? nodes : null;
    }
    // 自循环活动流：解析 <loop-decision> 记忆正文
    function parseLoopDecision(content) {
      const c = String(content ?? '');
      const time = c.match(/time="([^"]*)"/)?.[1] ?? '';
      const trigger = c.match(/trigger="([^"]*)"/)?.[1] ?? '';
      const analysis = c.match(/<analysis>([\s\S]*?)<\/analysis>/)?.[1] ?? '';
      const speak = c.match(/<speak>([\s\S]*?)<\/speak>/)?.[1] ?? '';
      const act = c.match(/<act>([\s\S]*?)<\/act>/)?.[1] ?? '';
      return { time, trigger, analysis, speak, act };
    }
    // 消息提示音：Web Audio 合成双音；浏览器自动播放策略要求用户首次交互后解锁
    let audioCtxRef = null;
    function playBeep() {
      try {
        const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
        if (!AC) return;
        if (!audioCtxRef) audioCtxRef = new AC();
        const ac = audioCtxRef;
        if (ac.state === 'suspended') void ac.resume();
        const t = ac.currentTime;
        for (const [freq, start, dur] of [[880, 0, 0.12], [660, 0.16, 0.2]]) {
          const osc = ac.createOscillator();
          const gain = ac.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.001, t + start);
          gain.gain.exponentialRampToValueAtTime(0.3, t + start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, t + start + dur);
          osc.connect(gain);
          gain.connect(ac.destination);
          osc.start(t + start);
          osc.stop(t + start + dur + 0.03);
        }
      } catch { /* 忽略 */ }
    }

    const inject = ['slots', 'connection', 'timer'];
    const MAIN_SESSION_ID = 'session-main';
    const PERSONA_SECTIONS = [
      ['identity', '身份'], ['values', '价值观'], ['traits', '性格'],
      ['style', '表达风格'], ['directives', '行为准则'], ['capabilities', '能力清单'],
    ];
    const FEATURES = [
      ['overview', '总控', '🎛️'], ['persona', '人格', '🧠'], ['loop', '思维循环', '🔄'], ['memory', '记忆', '📚'],
      ['evolution', '自进化', '⚗️'], ['consistency', '人格一致性', '🛡️'], ['schedule', '定时任务', '⏰'], ['notify', '通知', '🔔'], ['report', '简报', '📋'],
      ['tools', '工具', '🛠️'], ['models', '模型', '🧭'], ['vision', '识图', '🖼️'],
    ];
    const KIND_LABEL = { episodic: '事件', semantic: '语义', procedural: '程序', preference: '偏好', thought: '想法' };
    const STATUS_TONE = { pending: 'warn', applied: 'good', rejected: 'err', 'rolled-back': 'dim', failed: 'err', fired: 'good', cancelled: 'dim', missed: 'err' };

    // ---------- 主程序 ----------
    function apply(ctx) {
      //  加载诊断：硬刷新后若 Console 无此日志，说明 bundle 未执行（缓存/加载失败）
      try { console.log('[archive-control] client apply start'); } catch { /* ignore */ }
      const slots = ctx.get('slots');
      if (slots === undefined) return;
      // 样式注入：DSH 无 styles 服务，参照原生 ui-theme 直接操作 document（createElement('style') + head.appendChild）
      const CSS = `
:root{
  --arc-bg: var(--dsw-alias-bg-base, #151517);
  --arc-sb: var(--dsw-specific-sidebar-fill, #1c1c1e);
  --arc-l1: var(--dsw-alias-bg-layer-1, #1f1f21);
  --arc-l2: var(--dsw-alias-bg-layer-2, #232325);
  --arc-ol: var(--dsw-alias-bg-overlay, #2a2a2c);
  --arc-bd: var(--dsw-alias-border-l1, rgb(255 255 255 / 10%));
  --arc-bd2: var(--dsw-alias-border-l2, rgb(255 255 255 / 18%));
  --arc-tx: var(--dsw-alias-label-primary, #f9fafb);
  --arc-dim: var(--dsw-alias-label-secondary, #cfd3d6);
  --arc-faint: var(--dsw-alias-label-tertiary, #adb2b8);
  --arc-brand: var(--dsw-alias-brand-primary, #5686fe);
  --arc-good: var(--dsw-alias-state-success-primary, #4ed17e);
  --arc-warn: var(--dsw-alias-state-warn-primary, #f7ad31);
  --arc-err: var(--dsw-alias-state-error-primary, #f87171);
  --arc-font: var(--dsw-font-family, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
  --arc-mono: var(--ds-font-family-code, "SF Mono", Consolas, "Microsoft YaHei", monospace);
}
.arc-app{display:flex;height:100vh;width:100vw;background:var(--arc-bg);color:var(--arc-tx);font-family:var(--arc-font);font-size:14px;overflow:hidden}
.arc-app *{box-sizing:border-box}
.arc-app button{font-family:inherit}
.arc-app input,.arc-app select,.arc-app textarea{font-family:inherit;color:var(--arc-tx)}
.arc-app ::-webkit-scrollbar{width:10px;height:10px}
.arc-app ::-webkit-scrollbar-thumb{background:var(--arc-bd2);border-radius:6px;border:2px solid transparent;background-clip:content-box}
.arc-app ::-webkit-scrollbar-track{background:transparent}
/* ---- 侧栏 ---- */
.arc-sb{width:256px;min-width:256px;display:flex;flex-direction:column;background:var(--arc-sb);border-right:1px solid var(--arc-bd);padding:12px 10px;gap:10px;overflow:hidden}
.arc-brand{display:flex;align-items:center;gap:10px;padding:4px 6px 10px}
.arc-brand .dot{width:8px;height:8px;border-radius:50%;background:var(--arc-good);box-shadow:0 0 6px var(--arc-good)}
.arc-brand .nm{font-weight:700;font-size:15px;letter-spacing:.4px;color:var(--arc-tx)}
.arc-brand .st{font-size:11px;color:var(--arc-faint);margin-top:1px}
.arc-main-btn{width:100%;padding:10px 14px;border:none;border-radius:10px;cursor:pointer;font-size:14px;font-weight:600;color:#fff;text-align:left;background:var(--arc-brand);transition:filter .15s}
.arc-main-btn:hover{filter:brightness(1.12)}
.arc-feats{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.arc-feat{padding:8px 9px;border:1px solid var(--arc-bd);border-radius:9px;background:transparent;color:var(--arc-dim);cursor:pointer;font-size:12.5px;text-align:left;display:flex;align-items:center;gap:7px;transition:all .12s}
.arc-feat:hover{border-color:var(--arc-brand);color:var(--arc-tx);background:var(--arc-l1)}
.arc-feat.on{border-color:var(--arc-brand);background:var(--arc-l1);color:var(--arc-tx);font-weight:600}
.arc-feat .ic{font-size:14px}
/* 主会话栏（上部固定） */
.arc-mainsec{flex:none;border:1px solid var(--arc-bd);border-radius:10px;background:var(--arc-l1);overflow:hidden}
.arc-sech{padding:7px 12px 5px;font-size:11px;color:var(--arc-faint);display:flex;justify-content:space-between;letter-spacing:.4px}
.arc-mainrow{display:flex;align-items:center;gap:6px;height:34px;padding:0 8px;margin:0 4px 4px;border-radius:8px;cursor:pointer;color:var(--arc-tx);font-size:14px;user-select:none}
.arc-mainrow:hover{background:var(--arc-l2)}
.arc-mainrow.on{background:var(--arc-l2);font-weight:600}
/* 工作区（下部，参照 DSH 原生工作区浏览 Rows 设计：34px 项目行 / 32px 会话行、8px 圆角、hover 背景、chevron 旋转） */
.arc-ws{flex:1;min-height:0;display:flex;flex-direction:column;border:1px solid var(--arc-bd);border-radius:10px;background:var(--arc-l1);overflow:hidden}
.arc-ws-scroll{flex:1;overflow-y:auto;padding:4px}
.arc-wsh{display:flex;align-items:center;gap:6px;height:34px;padding:0 8px;border-radius:8px;cursor:pointer;user-select:none;color:var(--arc-tx)}
.arc-wsh:hover{background:var(--arc-l2)}
.arc-wsh .arc-ws-add{display:none;flex:none;align-items:center;justify-content:center;width:20px;height:20px;border:none;background:transparent;color:var(--arc-dim);cursor:pointer;font-size:14px;border-radius:5px;line-height:1}
.arc-wsh:hover .arc-ws-add{display:inline-flex}
.arc-wsh .arc-ws-add:hover{color:var(--arc-brand);background:var(--arc-l2)}
.arc-ws-chev{flex:none;width:16px;display:inline-flex;align-items:center;justify-content:center;color:var(--arc-faint);font-size:11px;transition:transform .15s var(--ds-ease-in-out, ease);transform:rotate(0deg)}
.arc-ws-chev.open{transform:rotate(90deg)}
.arc-ws-t{text-overflow:ellipsis;white-space:nowrap;overflow:hidden;font-size:14px;line-height:20px;min-width:0}
.arc-ws-m{text-overflow:ellipsis;white-space:nowrap;overflow:hidden;color:var(--arc-faint);font-size:11.5px;line-height:20px;min-width:0;max-width:45%}
.arc-wss{display:flex;align-items:center;gap:6px;height:32px;padding:0 8px 0 22px;margin:1px 0;border-radius:8px;cursor:pointer;color:var(--arc-dim);font-size:13px;animation:fade .15s}
.arc-wss:hover,.arc-wss.on{background:var(--arc-l2);color:var(--arc-tx)}
.arc-wss .arc-ws-t{flex:1}
.arc-wss .arc-ws-m{flex:none;max-width:40%}
.arc-sb-foot{display:flex;gap:6px;border-top:1px solid var(--arc-bd);padding-top:8px}
.arc-sb-foot button{flex:1;padding:6px 4px;border:1px solid var(--arc-bd);border-radius:8px;background:var(--arc-l1);color:var(--arc-dim);cursor:pointer;font-size:11.5px}
.arc-sb-foot button:hover{color:var(--arc-tx);border-color:var(--arc-brand)}
/* ---- 主区 ---- */
.arc-main{flex:1;display:flex;flex-direction:column;min-width:0}
.arc-top{display:flex;align-items:center;gap:12px;padding:0 20px;height:50px;border-bottom:1px solid var(--arc-bd);background:var(--arc-bg)}
.arc-top .t{font-weight:600;font-size:15px}
.arc-top .s{font-size:12px;color:var(--arc-dim)}
.arc-top .m{margin-left:auto;font-size:11px;color:var(--arc-dim);border:1px solid var(--arc-bd);padding:2px 10px;border-radius:999px;background:var(--arc-l1)}
.arc-chat{flex:1;overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column;gap:12px}
.arc-msg{max-width:78%;padding:10px 14px;border-radius:12px;font-size:13.5px;line-height:1.7;white-space:pre-wrap;word-break:break-word;animation:fade .18s}
@keyframes fade{from{opacity:0;transform:translateY(3px)}to{opacity:1}}
.arc-msg.user{align-self:flex-end;background:var(--arc-brand);color:#fff;border-bottom-right-radius:4px}
.arc-msg.ai{align-self:flex-start;background:var(--arc-l1);border:1px solid var(--arc-bd);border-bottom-left-radius:4px}
/*  系统消息（人格一致性拦截说明等 source.kind==='plugin'）灰字居中系统样式 */
.arc-msg.sys{align-self:center;background:transparent;border:1px dashed var(--arc-bd);color:var(--arc-faint);font-size:12px;max-width:92%;padding:6px 12px;border-radius:8px}
.arc-msg .who{font-size:10.5px;opacity:.75;margin-bottom:3px}
/* 思维链/工具调用（仿 DSH 本体——小字、折叠显示，不占主阅读流） */
.arc-msg .arc-reason{align-self:flex-start;max-width:100%;font-size:11.5px;color:var(--arc-dim);background:transparent;border:1px dashed var(--arc-bd);border-radius:8px;padding:4px 8px;margin:2px 0 8px}
.arc-msg .arc-reason summary{cursor:pointer;color:var(--arc-dim);user-select:none;font-size:11.5px}
.arc-msg .arc-reason summary:hover{color:var(--arc-tx)}
.arc-msg .arc-reason .arc-reason-body{margin-top:6px;white-space:pre-wrap;word-break:break-word;font-family:var(--arc-mono);line-height:1.5;max-height:220px;overflow:auto}
.arc-msg.arc-tool{align-self:flex-start;font-size:11.5px;color:var(--arc-dim);background:transparent;border:none;padding:2px 8px}
.arc-inp{display:flex;gap:10px;padding:12px 20px;border-top:1px solid var(--arc-bd);background:var(--arc-bg)}
.arc-inp input{flex:1;padding:10px 14px;border:1px solid var(--arc-bd);border-radius:10px;background:var(--arc-l1);color:var(--arc-tx);font-size:13.5px;outline:none}
.arc-inp input:focus{border-color:var(--arc-brand)}
.arc-inp button{padding:10px 22px;border:none;border-radius:10px;background:var(--arc-brand);color:#fff;font-weight:600;cursor:pointer}
.arc-inp button:hover{filter:brightness(1.12)}
/* ---- 功能页 ---- */
.arc-page{flex:1;overflow-y:auto;padding:20px 24px}
.arc-card{border:1px solid var(--arc-bd);border-radius:12px;background:var(--arc-l1);padding:16px;margin-bottom:14px}
.arc-card h3{margin:0 0 12px;font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px}
.arc-card .dim{color:var(--arc-dim);font-size:12.5px;line-height:1.7}
.arc-hint{color:var(--arc-faint);font-size:11.5px}
.arc-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-bottom:14px}
.arc-stat{border:1px solid var(--arc-bd);border-radius:10px;background:var(--arc-l1);padding:10px 12px}
.arc-stat .v{font-size:17px;font-weight:700;color:var(--arc-tx)}
.arc-stat .k{font-size:11px;color:var(--arc-dim);margin-top:2px}
.arc-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 2px;border-bottom:1px solid var(--arc-bd);font-size:13px}
.arc-row:last-child{border-bottom:none}
.arc-row .k{color:var(--arc-dim);flex:none}
.arc-row .v{color:var(--arc-tx);text-align:right;word-break:break-all;min-width:0}
.arc-btn{padding:6px 13px;border:1px solid var(--arc-bd);border-radius:8px;background:var(--arc-l1);color:var(--arc-tx);cursor:pointer;font-size:12.5px;transition:all .12s}
.arc-btn:hover{border-color:var(--arc-brand)}
.arc-btn.primary{background:var(--arc-brand);border-color:var(--arc-brand);color:#fff;font-weight:600}
.arc-btn.primary:hover{filter:brightness(1.12)}
.arc-btn.danger{border-color:var(--arc-err);color:var(--arc-err)}
.arc-btn.danger:hover{background:var(--arc-err);color:#fff}
.arc-btn.small{padding:3px 9px;font-size:11.5px;border-radius:7px}
.arc-btn:disabled{opacity:.45;cursor:not-allowed}
.arc-text,.arc-sel{width:100%;background:var(--arc-l1);color:var(--arc-tx);border:1px solid var(--arc-bd);border-radius:9px;padding:8px 11px;font-size:13px;margin:5px 0;outline:none}
.arc-text:focus,.arc-sel:focus{border-color:var(--arc-brand)}
.arc-textarea{width:100%;background:var(--arc-l1);color:var(--arc-tx);border:1px solid var(--arc-bd);border-radius:9px;padding:8px 11px;font-size:13px;margin:5px 0;outline:none;resize:vertical;min-height:64px;font-family:var(--arc-mono)}
.arc-textarea:focus{border-color:var(--arc-brand)}
.arc-badge{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid var(--arc-bd);color:var(--arc-dim);background:var(--arc-l2)}
.arc-badge.good{color:var(--arc-good);border-color:var(--arc-good)}
.arc-badge.warn{color:var(--arc-warn);border-color:var(--arc-warn)}
.arc-badge.err{color:var(--arc-err);border-color:var(--arc-err)}
.arc-badge.brand{color:var(--arc-brand);border-color:var(--arc-brand)}
.arc-tabs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:12px;border-bottom:1px solid var(--arc-bd);padding-bottom:0}
.arc-tab{padding:6px 14px;border:none;background:transparent;color:var(--arc-dim);cursor:pointer;font-size:13px;border-bottom:2px solid transparent;margin-bottom:-1px}
.arc-tab:hover{color:var(--arc-tx)}
.arc-tab.on{color:var(--arc-tx);border-bottom-color:var(--arc-brand);font-weight:600}
.arc-note{color:var(--arc-dim);font-size:12px;line-height:1.7}
.arc-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--arc-faint);gap:10px}
.arc-empty .big{font-size:40px}
.arc-list{border:1px solid var(--arc-bd);border-radius:10px;background:var(--arc-bg);overflow:hidden}
.arc-item{padding:11px 14px;border-bottom:1px solid var(--arc-bd)}
.arc-item:last-child{border-bottom:none}
.arc-item:hover{background:var(--arc-l1)}
.arc-item.arc-sel{background:var(--arc-l1);box-shadow:inset 2px 0 0 var(--arc-brand)}
.arc-item .t1{font-size:13px;line-height:1.6;color:var(--arc-tx);white-space:pre-wrap;word-break:break-word}
.arc-item .t2{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px;font-size:11px;color:var(--arc-faint)}
.arc-item .ops{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.arc-tag{font-family:var(--arc-mono);font-size:11px;color:var(--arc-faint);background:var(--arc-l1);border:1px solid var(--arc-bd);padding:0 6px;border-radius:5px}
.arc-progress{height:4px;border-radius:2px;background:var(--arc-l2);overflow:hidden}
.arc-progress>div{height:100%;background:var(--arc-brand)}
.arc-toast{position:fixed;bottom:76px;right:20px;background:var(--arc-ol);border:1px solid var(--arc-bd2);color:var(--arc-tx);padding:10px 16px;border-radius:10px;font-size:12.5px;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.3);max-width:380px}
/* 关闭按钮：置于顶部条内（model 徽标右侧），不再悬浮右下角（避免遮挡输入框发送键） */
.arc-shutdown{display:inline-flex;align-items:center;gap:6px;margin-left:6px;padding:5px 14px;border:1px solid var(--arc-bd);border-radius:999px;background:var(--arc-l1);color:var(--arc-dim);cursor:pointer;font-size:12px;font-weight:600;transition:all .15s}
.arc-shutdown:hover{border-color:var(--arc-err);color:var(--arc-err);background:var(--arc-l1)}
.arc-shutdown:disabled{opacity:.6;cursor:wait}
.arc-confirm{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:10000}
.arc-confirm .box{background:var(--arc-ol);border:1px solid var(--arc-bd2);border-radius:12px;padding:18px;width:360px;max-width:90vw;box-shadow:0 8px 40px rgba(0,0,0,.4)}
.arc-confirm .msg{font-size:13px;line-height:1.7;margin-bottom:14px;white-space:pre-wrap;word-break:break-word}
.arc-confirm .ops{display:flex;justify-content:flex-end;gap:8px}
/* ---- 未配置模型提供商横幅 ---- */
.arc-banner-warn{background:rgba(255,176,32,.1);border:1px solid rgba(255,176,32,.45);color:#f5a623;border-radius:10px;padding:10px 14px;font-size:13px;line-height:1.6;margin-bottom:12px}
/* ---- 消息富文本：markdown-lite + 图片引用缩略图 ---- */
.arc-msg-p{margin:2px 0;white-space:pre-wrap;word-break:break-word}
.arc-msg-p:first-child{margin-top:0}
.arc-msg-p:last-child{margin-bottom:0}
.arc-msg pre{background:var(--arc-ol);border:1px solid var(--arc-bd);border-radius:8px;padding:10px 12px;overflow-x:auto;font-family:var(--arc-mono);font-size:12.5px;line-height:1.6;margin:6px 0;white-space:pre-wrap;word-break:break-word}
.arc-msg code{font-family:var(--arc-mono);font-size:12.5px;background:var(--arc-ol);border:1px solid var(--arc-bd);border-radius:4px;padding:0 4px}
.arc-msg pre code{background:none;border:none;padding:0;border-radius:0}
.arc-msg img.arc-msg-img{max-width:min(320px,100%);max-height:220px;object-fit:contain;border-radius:10px;border:1px solid var(--arc-bd);margin:4px 0;display:block;cursor:zoom-in}
.arc-msg a{color:var(--arc-brand)}
/* ---- 输入框图片按钮与粘贴预览条（粘贴图片/预览/随消息发送） ---- */
.arc-img-btn{flex:none;width:40px;border:1px solid var(--arc-bd);border-radius:10px;background:var(--arc-l1);color:var(--arc-dim);cursor:pointer;font-size:16px}
.arc-img-btn:hover{border-color:var(--arc-brand);color:var(--arc-tx)}
.arc-img-btn:disabled{opacity:.5;cursor:wait}
.arc-pastebar{display:flex;gap:8px;flex-wrap:wrap;padding:8px 20px 0;background:var(--arc-bg)}
.arc-paste-item{position:relative;width:72px;height:72px;border-radius:8px;overflow:hidden;border:1px solid var(--arc-bd2);background:var(--arc-l1)}
.arc-paste-item img{width:100%;height:100%;object-fit:cover;display:block}
.arc-paste-x{position:absolute;top:2px;right:2px;width:18px;height:18px;border:none;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;cursor:pointer;font-size:11px;line-height:1;display:flex;align-items:center;justify-content:center}
.arc-paste-x:hover{background:var(--arc-err)}
/* ---- 会话重命名弹窗 ---- */
.arc-rename-input{width:100%;background:var(--arc-l1);color:var(--arc-tx);border:1px solid var(--arc-bd);border-radius:9px;padding:9px 12px;font-size:13px;margin:4px 0 12px;outline:none}
.arc-rename-input:focus{border-color:var(--arc-brand)}
/* ---- 活动流时间线 ---- */
.arc-tl{border-left:2px solid var(--arc-bd);margin:4px 0 4px 8px;padding-left:14px}
.arc-tl-item{position:relative;padding:0 0 14px}
.arc-tl-item::before{content:'';position:absolute;left:-19px;top:5px;width:8px;height:8px;border-radius:50%;background:var(--arc-brand)}
.arc-tl-item .t3{font-size:11px;color:var(--arc-faint);margin-bottom:3px}
.arc-tl-item .t4{font-size:12.5px;color:var(--arc-dim);line-height:1.6;white-space:pre-wrap;word-break:break-word;font-family:var(--arc-mono)}
/* ---- 通知未读角标 ---- */
.arc-feat .arc-dot{display:none;margin-left:auto;min-width:8px;height:8px;border-radius:50%;background:var(--arc-err);box-shadow:0 0 4px var(--arc-err)}
.arc-feat.has-unread .arc-dot{display:inline-block}
.arc-wss .arc-del{display:none;flex:none;width:18px;height:18px;border:none;background:transparent;color:var(--arc-faint);cursor:pointer;font-size:12px;border-radius:5px;line-height:1}
.arc-wss:hover .arc-del{display:inline-flex;align-items:center;justify-content:center}
.arc-wss .arc-del:hover{color:var(--arc-err);background:var(--arc-l2)}
/* ---- 流式输出开关 / 流式消息 / 工具调用 ---- */
.arc-stream-toggle{flex:none;border:1px solid var(--arc-bd);border-radius:8px;background:var(--arc-l1);color:var(--arc-dim);cursor:pointer;font-size:12px;padding:4px 10px}
.arc-stream-toggle:hover{border-color:var(--arc-brand);color:var(--arc-tx)}
.arc-msg.ai.streaming{box-shadow:0 0 0 1px rgba(124,170,255,.35)}
/* 人格一致性：被拦截消息灰显斜体 */
.arc-msg.ai.intercepted{opacity:.62;font-style:italic;border-style:dashed;background:var(--arc-ol)}
.arc-tools{display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 6px}
.arc-tool-chip{font-size:11px;color:var(--arc-dim);background:var(--arc-ol);border:1px solid var(--arc-bd);border-radius:6px;padding:1px 6px}
/* ---- 目录浏览弹窗（browse 能力， 手机端修复） ---- */
.arc-browse{width:min(480px,92vw);max-width:none}
.arc-browse-crumbs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}
.arc-browse-path{font-size:12px;color:var(--arc-faint);word-break:break-all;margin-bottom:8px;font-family:var(--arc-mono)}
.arc-browse-list{max-height:260px;overflow-y:auto;border:1px solid var(--arc-bd);border-radius:8px;padding:4px;margin-bottom:10px;display:flex;flex-direction:column;gap:2px}
.arc-browse-item{text-align:left;justify-content:flex-start;padding:7px 10px;font-size:13px;border:1px solid transparent}
.arc-browse-item:hover{border-color:var(--arc-brand)}
.arc-browse-item.hidden{opacity:.55}
/* ---- 记录面板 Dock（）：底部可收起、提示词/报错双页签；.arc-app 以 --arc-dock-h 告知展开高度，
   toast 等 fixed 浮层据此上移避让，展开/收起均不遮挡内容 ---- */
.arc-dock{flex:none;display:flex;flex-direction:column;border-top:1px solid var(--arc-bd);background:var(--arc-l1)}
.arc-dock-bar{display:flex;align-items:center;gap:8px;height:36px;min-height:36px;padding:0 10px;font-size:12px;color:var(--arc-dim)}
.arc-dock-tab{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--arc-bd);background:transparent;color:var(--arc-dim);border-radius:8px;padding:3px 10px;font-size:12px;cursor:pointer;transition:all .12s}
.arc-dock-tab:hover{border-color:var(--arc-brand);color:var(--arc-tx)}
.arc-dock-tab.on{background:var(--arc-brand);border-color:var(--arc-brand);color:#fff;font-weight:600}
.arc-dock-tab .n{opacity:.85;font-size:11px}
.arc-dock-btn{border:1px solid var(--arc-bd);background:transparent;color:var(--arc-dim);border-radius:8px;padding:3px 8px;font-size:11.5px;cursor:pointer;white-space:nowrap}
.arc-dock-btn:hover{border-color:var(--arc-brand);color:var(--arc-tx)}
.arc-dock-btn.danger:hover{border-color:var(--arc-err);color:var(--arc-err)}
.arc-dock-panel{height:min(40vh,320px);display:flex;flex-direction:column;border-top:1px solid var(--arc-bd)}
.arc-dock-list{flex:1;overflow-y:auto;padding:6px 10px;display:flex;flex-direction:column;gap:6px}
.arc-dock-empty{color:var(--arc-faint);font-size:12px;text-align:center;padding:18px 8px;line-height:1.7}
.arc-led{display:flex;flex-direction:column;border:1px solid var(--arc-bd);border-radius:8px;background:var(--arc-bg);overflow:hidden;flex:none}
.arc-led-h{display:flex;align-items:center;gap:8px;padding:5px 8px;font-size:11.5px;min-height:30px}
.arc-led-chip{font-size:10.5px;font-weight:600;border-radius:5px;padding:1px 6px;white-space:nowrap;flex:none}
.arc-led-time{color:var(--arc-faint);white-space:nowrap;flex:none;font-family:var(--arc-mono);font-size:10.5px}
.arc-led-model{color:var(--arc-faint);font-family:var(--arc-mono);font-size:10.5px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none}
.arc-led-status{font-size:10.5px;white-space:nowrap;flex:none}
.arc-led-msg{flex:1;min-width:0;color:var(--arc-dim);font-size:11.5px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.arc-led-exp{white-space:pre-wrap;word-break:break-word;font-family:var(--arc-mono);font-size:11px;line-height:1.65;color:var(--arc-dim);padding:6px 10px;border-top:1px dashed var(--arc-bd);max-height:170px;overflow-y:auto}
.arc-led-ops{margin-left:auto;display:flex;gap:4px;flex:none}
/* ---- 审批卡（仿 DSH 本体 ApprovalPanel：warn 描边卡 + 条头 + 拒绝/允许一次） ---- */
.arc-aprv-wrap{display:flex;flex-direction:column;gap:8px;padding:10px 20px 0}
/* 功能页悬浮审批（fixed 于底部中央上方，避开记录面板） */
.arc-aprv-float{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(84px + var(--arc-dock-h, 36px));z-index:900;width:min(560px,calc(100vw - 48px));display:flex;flex-direction:column;gap:8px;max-height:40vh;overflow-y:auto}
.arc-aprv-card{border:1px solid var(--arc-warn);background:var(--arc-l1);box-shadow:0 4px 14px rgba(0,0,0,.25);border-radius:14px;overflow:hidden}
.arc-aprv-strip{background:color-mix(in srgb, var(--arc-warn) 16%, transparent);color:var(--arc-warn);display:flex;align-items:center;gap:8px;padding:8px 14px;font-size:12.5px}
.arc-aprv-strip .dot{width:8px;height:8px;border-radius:50%;background:var(--arc-warn);flex:none}
.arc-aprv-strip .tl{opacity:.75;font-size:11px}
.arc-aprv-body{padding:10px 14px 0;font-size:13px;line-height:1.6;color:var(--arc-tx);word-break:break-word;max-height:96px;overflow-y:auto}
.arc-aprv-actions{display:flex;justify-content:flex-end;gap:8px;padding:10px 14px 12px}
/* ---- 权限预设（仿 DSH 本体 composer 访问模式） ---- */
.arc-perm-row{display:flex;align-items:center;gap:8px;padding:8px 20px 0}
.arc-perm-row .lbl{font-size:11px;color:var(--arc-faint);flex:none}
.arc-perm-wrap{position:relative;flex:none}
.arc-perm-pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--arc-bd);border-radius:8px;background:var(--arc-l1);color:var(--arc-dim);cursor:pointer;font-size:12px;padding:4px 10px}
.arc-perm-pill:hover{border-color:var(--arc-brand);color:var(--arc-tx)}
.arc-perm-pill.full{border-color:var(--arc-warn);color:var(--arc-warn)}
.arc-perm-menu{position:absolute;top:calc(100% + 4px);left:0;z-index:120;display:flex;flex-direction:column;gap:2px;padding:4px;border:1px solid var(--arc-bd);border-radius:10px;background:var(--arc-ol);box-shadow:0 6px 18px rgba(0,0,0,.35);min-width:190px;max-width:calc(100vw - 48px)}
.arc-perm-item{display:flex;align-items:center;gap:8px;text-align:left;padding:7px 10px;border:none;border-radius:7px;background:transparent;color:var(--arc-tx);cursor:pointer;font-size:12.5px}
.arc-perm-item:hover{background:var(--arc-l2)}
.arc-perm-item.on{color:var(--arc-brand);font-weight:600}
.arc-perm-item.full{color:var(--arc-warn)}
.arc-perm-item:disabled{opacity:.55;cursor:wait}
.arc-toast{bottom:calc(76px + var(--arc-dock-h, 36px))}
`;
      if (typeof document !== 'undefined' && typeof ctx.effect === 'function') {
        ctx.effect(() => {
          const tag = document.createElement('style');
          tag.setAttribute('data-plugin-css', 'archive-control');
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => { try { tag.remove(); } catch { /* ignore */ } };
        });
      }

      const connection = ctx.get('connection');
      const timer = ctx.get('timer');

      // 统一规范化 RPC 响应：服务端错误 result.error 是对象 {code,message,details}，
      // 直接拼进 toast 会显示 "[object Object]" —— 统一提取 message（ 修复）。
      function normResult(res) {
        if (res === null || res === undefined) return { ok: false, error: 'no response' };
        if (res.ok === false && res.error && typeof res.error !== 'string') {
          return { ...res, error: String((res.error && res.error.message) || JSON.stringify(res.error)) };
        }
        return res;
      }
      async function rpc(op, args = {}) {
        try {
          if (connection === undefined) return { ok: false, error: 'connection unavailable' };
          // 专属通道（Host: connection.rpc.handle('/archive-control')）；/api 共享通道被 api-gateway 独占
          const res = await connection.rpc.call('/archive-control', 'archive-control', { args: { op, args } });
          return normResult(res);
        } catch (error) { return { ok: false, error: String(error && error.message || error) }; }
      }
      // 记录面板专用通道（Host: modules/ledger connection.rpc.handle('/archive-ledger')），与 /archive-control 同信封
      async function ledRpc(op, args = {}) {
        try {
          if (connection === undefined) return { ok: false, error: 'connection unavailable' };
          const res = await connection.rpc.call('/archive-ledger', 'archive-ledger', { args: { op, args } });
          return normResult(res);
        } catch (error) { return { ok: false, error: String(error && error.message || error) }; }
      }
      async function api(method, payload) {
        try {
          if (connection === undefined) return { ok: false, error: 'connection unavailable' };
          //  修复：payload 必须直传（不可包 {args:...}）——api-gateway 直接校验顶层字段，
          // 包一层 args 会使 session.prompt/history/cancel/rename 全部报 "invalid payload" → 发送失败。
          const res = await connection.rpc.call('/api', method, payload);
          return normResult(res);
        } catch (error) { return { ok: false, error: String(error && error.message || error) }; }
      }

      // ===== 浏览器端错误捕获（）：window error / unhandledrejection → ledger 报错面板 =====
      if (typeof window !== 'undefined' && typeof ctx.effect === 'function') {
        ctx.effect(() => {
          let lastPush = 0;
          const push = (level, message, stack) => {
            const now = Date.now();
            if (now - lastPush < 2000) return; // 节流：错误风暴不刷爆 RPC
            lastPush = now;
            void ledRpc('errors.push', { level, module: 'web', message: String(message ?? '').slice(0, 2000), stack: String(stack ?? '').slice(0, 4000) });
          };
          const onWinErr = (ev) => push('error', ev?.message || String(ev?.error ?? ''), ev?.error?.stack ?? '');
          const onRej = (ev) => { const r = ev?.reason; push('unhandled', (r && r.message) || String(r ?? ''), r?.stack ?? ''); };
          window.addEventListener('error', onWinErr);
          window.addEventListener('unhandledrejection', onRej);
          return () => {
            window.removeEventListener('error', onWinErr);
            window.removeEventListener('unhandledrejection', onRej);
          };
        });
      }

      // ================= 通用小部件 =================
      function Card({ title, right, children }) {
        return e('div', { className: 'arc-card' },
          title ? e('h3', null, e('span', null, title), right ? e('span', { style: { marginLeft: 'auto' } }, right) : null) : null,
          children);
      }
      function Btn({ label, onClick, kind, small, disabled, title }) {
        return e('button', {
          className: `arc-btn${kind ? ' ' + kind : ''}${small ? ' small' : ''}`,
          onClick, disabled: !!disabled, title,
        }, label);
      }
      function Badge({ text, tone }) {
        return e('span', { className: `arc-badge${tone ? ' ' + tone : ''}` }, text);
      }
      function Stats({ items }) {
        return e('div', { className: 'arc-stats' },
          items.map((it) => e('div', { key: it.k, className: 'arc-stat' },
            e('div', { className: 'v' }, String(it.v ?? '—')),
            e('div', { className: 'k' }, it.k))));
      }
      function Row({ k, v, mono }) {
        return e('div', { className: 'arc-row' },
          e('span', { className: 'k' }, k),
          e('span', { className: 'v', style: mono ? { fontFamily: 'var(--arc-mono)' } : null }, String(v ?? '—')));
      }
      function Empty({ icon, text, sub }) {
        return e('div', { className: 'arc-empty' },
          e('div', { className: 'big' }, icon),
          e('div', { style: { fontSize: 13.5 } }, text),
          sub ? e('div', { className: 'arc-note' }, sub) : null);
      }

      /**
       * 聊天输入框（ 性能修复）。
       * 原实现 `draft` 挂在 App 上（L581 起的顶层组件，渲染代码近 2900 行，含侧边栏与整段聊天记录），
       * 于是每敲一个键都触发 App 整棵树重渲染——单次按键阻塞主线程数十毫秒，表现为"在总控里打字明显卡顿"，
       * 而 CPU 占用看起来却很低（按键是间歇的，2 秒均值把它摊平了）。
       * 现在 draft 收进本组件内部：按键只重渲染这一个输入框，App 与聊天记录完全不动。
       * 语义零改动：仍是受控输入、同样的 Enter 发送、同样的中文输入法合成（isComposing）守卫、同样的发送后清空。
       * 放在 apply 作用域（而非 App 内部）是必须的——若定义在 App 里，每次渲染都会产生新组件类型导致输入框被卸载重建。
       * props 多为 App 内联闭包（每次 App 渲染都是新引用），故 memo 的收益有限；真正的修复是状态隔离本身。
       */
      const ChatComposer = React.memo(function ChatComposer({ onPaste, sendText, replying, stopGenerate, uploading, fileRef, uploadImage }) {
        const [draft, setDraft] = useState('');
        const submit = () => { void sendText(draft).then((ok) => { if (ok) setDraft(''); }); };
        return e('div', { className: 'arc-inp' },
          e('button', { className: 'arc-img-btn', disabled: uploading, title: '上传/粘贴图片（AI 识别）', onClick: () => fileRef.current?.click() }, uploading ? '…' : '🖼️'),
          e('input', { ref: fileRef, type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', style: { display: 'none' }, onChange: (ev) => { if (ev.target.files?.[0]) void uploadImage(ev.target.files[0]); ev.target.value = ''; } }),
          e('input', { value: draft, placeholder: '输入消息，Enter 发送；可直接粘贴图片…', onChange: (ev) => setDraft(ev.target.value), onPaste, onKeyDown: (ev) => { if (ev.key === 'Enter' && !ev.nativeEvent?.isComposing) submit(); } }),
          replying
            ? e('button', { onClick: () => void stopGenerate() }, '⏹ 停止')
            : e('button', { onClick: submit }, '发送'),
        );
      });

      // ================= 应用 =================
      function App() {
        const [page, setPage] = useState('chat');
        const [currentId, setCurrentId] = useState(MAIN_SESSION_ID);
        const [sessions, setSessions] = useState([]);
        const [workspaces, setWorkspaces] = useState([]);
        const [wsExpanded, setWsExpanded] = useState({});
        const [archivedIds, setArchivedIds] = useState([]);
        const [messages, setMessages] = useState([]);
        const [model, setModel] = useState('');
        const [status, setStatus] = useState('连接中…');
        const [toast, setToast] = useState('');
        const [confirm, setConfirm] = useState(null); // {msg, onYes}
        const [shuttingDown, setShuttingDown] = useState(false);
        const [newSessionOpen, setNewSessionOpen] = useState(false);
        const [newWsId, setNewWsId] = useState('');
        const [newWsPath, setNewWsPath] = useState('');
        const [pickingDir, setPickingDir] = useState(false);
        const [browseOpen, setBrowseOpen] = useState(false); //：browse 能力下自绘目录浏览弹窗
        //：未读通知角标 / 回复中指示 / 图片上传（粘贴+预览+随消息发送）/ 会话重命名 / 桌面通知
        const [unread, setUnread] = useState(0);
        const [replying, setReplying] = useState(false);
        //  修复（L7）："回复中" 60s 兜底 timer 统一经 ref 管理——
        // ①多次发送各自 setTimeout，旧 timer 会在仍在生成时提前把"停止"复位成"发送"；
        // ②长回复持续输出时固定 60s 计时也会中途误复位。改语义：每次进入生成态
        // （发送成功 / 每收到 chunk 活动信号）都重置计时；真实结束（message 帧/停止/切换）清除。
        const replyingTimerRef = useRef(null);
        const clearReplyingTimer = () => {
          if (replyingTimerRef.current !== null) { try { clearTimeout(replyingTimerRef.current); } catch { /* ignore */ } replyingTimerRef.current = null; }
        };
        const armReplyingTimer = () => {
          clearReplyingTimer();
          replyingTimerRef.current = setTimeout(() => { replyingTimerRef.current = null; setReplying(false); }, 60000);
        };
        const markReplying = (v) => {
          setReplying(v);
          if (v) armReplyingTimer();
          else clearReplyingTimer();
        };
        const [uploading, setUploading] = useState(false);
        const [pasteImgs, setPasteImgs] = useState([]); // [{key, markdown, thumb}]
        const [renaming, setRenaming] = useState(null); // {id, title}
        const fileRef = useRef(null);
        const chatRef = useRef(null);
        const pageRef = useRef(null); // 功能页内容区滚动容器（.arc-page）
        //  人格一致性：会话消息 seq → 判定映射（suspicious 修订版 / blocked 拦截），渲染层替换显示
        const consistencyMapRef = useRef({});
        const lastConsistencyPullRef = useRef(0);
        //  性能修复：一致性 seqMap 的修订号——与上次相同则跳过赋值与整段聊天重渲染。
        // null 表示"尚无基线"，首次一定生效（服务端重启后 rev 归零也不会被误判为未变）。
        const lastConsistencyRevRef = useRef(null);
        // 滚动粘连（ 修复"翻阅历史被拉回底部"）：用户上翻时停止自动滚底，回到底部后恢复；
        //  分页：滚到顶部时自动加载更早一页历史（hasMore 时），并保持视口位置。
        const stickRef = useRef(true);
        const onChatScroll = () => {
          const el = chatRef.current;
          if (!el) return;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (el.scrollTop < 60 && !loadingOlderRef.current) void loadOlder();
        };
        const lastUnreadRef = useRef(0);
        const notifiedOnceRef = useRef(false);

        //  性能修复：原为普通函数——App 每次重渲染都产生新引用，会击穿记录面板行组件的
        // React.memo（App 侧 3s tick 等会频繁 setState）。依赖仅 setToast（useState 的稳定 setter）。
        const showToast = useCallback((t) => { setToast(t); setTimeout(() => setToast(''), 3500); }, []);
        const askConfirm = (msg, onYes) => setConfirm({ msg, onYes });
        const stateRef = useRef({ currentId });
        stateRef.current.currentId = currentId;
        //  流式/分页改造：
        //  - streamingRef/streaming：流式输出开关（settings archive-ui 持久化；开=SSE 实时增量渲染，关=轮询）
        //  - chatCacheRef：每个会话已加载事件缓存 { bySeq:Map, hasMore, headSeq, tailSeq, loadingOlder }
        //  - inFlightRef：当前会话流式进行中的 assistant 增量（assistant/chunk 累积，assistant/message 落库后清空）
        //  - optimisticRef：发送后立即上屏的用户消息（未落库前占位；收到真实 user/message 事件按文本匹配移除）
        const [streaming, setStreaming] = useState(true);
        const streamingRef = useRef(true);
        //  权限预设 + 待审批（仿 DSH 本体 composer 的访问模式与 ApprovalPanel）：
        //  - perm：当前聊天会话的权限预设状态 {available, sessionId, current, options}
        //  - permOpen：权限下拉是否展开
        //  - pendingApprovals：当前收到的待审批请求（mux approval/requested 帧），
        //    渲染在聊天输入区上方，允许一次/拒绝后经 /api/respond 回包
        const [perm, setPerm] = useState(null);
        const [permOpen, setPermOpen] = useState(false);
        const [permBusy, setPermBusy] = useState(false);
        const [pendingApprovals, setPendingApprovals] = useState([]);
        const chatCacheRef = useRef({});
        const inFlightRef = useRef(null);
        const optimisticRef = useRef([]);
        const loadingOlderRef = useRef(false);
        const streamAbortRef = useRef(null);
        const renderChatRef = useRef(null); // 由 useCallback 赋值，供 SSE 回调读取
        // 最近新建的会话（60s 内侧栏始终显示，消除新建后因时序/未切回导致的"看不到"；之后恢复"空白非当前隐藏"）
        const newlyCreatedRef = useRef({});
        const isNewlyCreated = (sid) => (newlyCreatedRef.current[sid] ?? 0) > Date.now() - 60000;
        // 勿扰模式：开启后仅不响提示音，其余不变；ref 供 useCallback 内读取
        const dndRef = useRef(false);

        // 桌面通知 + 提示音（收到新主动消息弹系统通知并播放提示音；勿扰模式开启时仅不响提示音）
        const notifyDesktop = useCallback((title, body) => {
          try {
            if (typeof Notification === 'undefined') return;
            const fire = () => {
              try { new Notification(title, { body, tag: 'archive-notify' }); } catch { /* 忽略 */ }
              if (!dndRef.current) playBeep();
            };
            if (Notification.permission === 'granted') fire();
            else if (Notification.permission === 'default') Notification.requestPermission().then((p) => { if (p === 'granted') fire(); }).catch(() => {});
          } catch { /* 忽略 */ }
        }, []);

        // 侧栏数据：工作区（workspace.list，含每工作区 sessionIds）+ 会话详情（session.list）+ 未读通知
        const refreshSidebar = useCallback(async () => {
          const [wr, sr] = await Promise.all([api('workspace.list', {}), api('session.list', {})]);
          if (wr && wr.ok && Array.isArray(wr.value?.items)) {
            setWorkspaces(wr.value.items);
            setArchivedIds(Array.isArray(wr.value?.archivedSessionIds) ? wr.value.archivedSessionIds : []);
            setWsExpanded((prev) => {
              let changed = false;
              const next = { ...prev };
              for (const w of wr.value.items) {
                if (next[w.workspaceId] === undefined) { next[w.workspaceId] = true; changed = true; }
              }
              return changed ? next : prev;
            });
            setStatus(`已连接 · ${wr.value.items.length} 个工作区`);
          }
          if (sr && sr.ok && Array.isArray(sr.value?.items)) setSessions(sr.value.items);
          const nr = await rpc('notify.stats');
          if (nr.ok && nr.value?.unread != null) {
            const prev = lastUnreadRef.current;
            const next = nr.value.unread;
            lastUnreadRef.current = next;
            if (next > prev && notifiedOnceRef.current) {
              // 新未读 → 取最新一条发桌面通知（首次不打扰，仅在收到新通知时弹）
              const v = await rpc('notify.view', { limit: 1 });
              const first = v.ok && Array.isArray(v.value?.notifications) ? v.value.notifications.find((n) => !n.read) : null;
              if (first?.content) notifyDesktop('DSH-ARCHIVE · 新消息', String(first.content).slice(0, 200));
            }
            if (next > 0) notifiedOnceRef.current = true;
            setUnread(next);
          }
        }, [rpc, notifyDesktop]);
        const toggleWs = (id) => setWsExpanded((prev) => ({ ...prev, [id]: prev[id] === false }));
        // 从事件缓存生成渲染消息列表（含流式进行中条目与乐观用户消息）
        const renderChatMessages = useCallback((sessionId) => {
          const c = chatCacheRef.current[sessionId];
          if (!c) return;
          //  修复（M1）：迟到请求守卫——快速切换会话时旧会话 loadTail 晚到会覆盖当前会话聊天区。
          // 缓存本身仍按会话累积（切回时 force 重渲染），此处只阻止非当前会话的渲染写入显示。
          if (sessionId !== stateRef.current.currentId) return;
          const events = [...c.bySeq.values()].sort((a, b) => a.seq - b.seq);
          const msgs = collectMessages(events, consistencyMapRef.current);
          //  修复（M5）：乐观用户消息先于 AI 流式回复渲染——用户刚发的消息（发送中…）
          // 是 AI 回复的前提，服务端回显延迟时不能让"你（发送中…）"排到 AI 气泡之下（时序倒挂）。
          const opts = optimisticRef.current.filter((o) => o.sid === sessionId);
          if (opts.length > 0) {
            //  修复（H1）：轮询模式（流式关闭）下真实 user/message 由 loadTail 落入缓存，
            // 乐观占位若仍渲染会同一条消息双份显示。渲染前按文本去重：缓存已含同文本真实消息 → 跳过占位。
            const realUserTexts = msgs.filter((m) => m.role === 'user').map((m) => m.text).filter(Boolean);
            for (const o of opts) {
              const dup = realUserTexts.some((t) => o.text === t || o.text.startsWith(t) || t.startsWith(o.text));
              if (dup) continue;
              msgs.push({ role: 'user', text: o.text, time: o.time, key: o.uid, optimistic: true });
            }
          }
          const fl = inFlightRef.current;
          if (fl && fl.turn !== undefined && sessionId === stateRef.current.currentId) {
            //  修复（M3）：轮询兜底落库后若缓存已含同 turn/step 的完整 assistant/message
            // （断流漏帧场景），in-flight 半成品不再渲染并清除，防"半成品气泡+最终消息"并存。
            const settled = events.some((ev0) => {
              const d = ev0?.event?.data ?? ev0?.data ?? {};
              return ev0?.event?.type === 'assistant/message' && d.turn === fl.turn && d.step === fl.step;
            });
            if (settled) {
              inFlightRef.current = null;
            } else {
              msgs.push({ role: 'assistant', text: fl.text, reasoning: fl.reasoning, tools: fl.tools, time: fl.time, key: 'inflight', streaming: true });
            }
          }
          setMessages(msgs);
          if (!fl && msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') markReplying(false);
        }, []);
        renderChatRef.current = renderChatMessages;
        /** 拉取一页历史并合并进会话缓存。无 beforeSeq=尾部最新页；有 beforeSeq=更早一页（向上翻历史）。
         *  force=true：无论是否有新事件都重新渲染（openSession/刷新等"已清空显示"后的调用必须 force，
         *  否则缓存已完整时无新事件 → 渲染被跳过 → 历史消失）。
         *  probeOnly=true（ 性能优化，仅轮询兜底使用）：先拉尾部 1 条探测最新 seq，
         *  无新增则跳过全量拉取——尾部 100 条 ≈1.85MB/次降为探测 ≈17KB/次（mux 流式正常时每次轮询都命中跳过）；
         *  探测只判断"有无新事件"，不更新 hasMore（避免污染向上翻页状态）。 */
        const loadTail = useCallback(async (sessionId, opts = {}) => {
          if (!sessionId) return;
          const c = chatCacheRef.current[sessionId] ?? (chatCacheRef.current[sessionId] = { bySeq: new Map(), hasMore: true, headSeq: Infinity, tailSeq: -1 });
          if (opts.probeOnly === true && c.tailSeq >= 0) {
            const probe = await api('session.history', { sessionId, maxMessages: 1 });
            if (probe && probe.ok && Array.isArray(probe.value?.events)) {
              let latest = -1;
              for (const entry of probe.value.events) {
                const ev = entry?.event ?? entry;
                if (ev && typeof ev.seq === 'number' && ev.seq > latest) latest = ev.seq;
              }
              if (latest <= c.tailSeq) return c; // 无新事件：跳过全量拉取
            }
          }
          const r = await api('session.history', {
            sessionId,
            maxMessages: opts.beforeSeq !== undefined ? 100 : HISTORY_PAGE,
            ...(opts.beforeSeq !== undefined ? { beforeSeq: opts.beforeSeq } : {}),
          });
          if (r && r.ok && Array.isArray(r.value?.events)) {
            let changed = false;
            for (const entry of r.value.events) {
              const ev = entry?.event ?? entry;
              if (!ev || typeof ev.seq !== 'number') continue;
              if (!c.bySeq.has(ev.seq)) { c.bySeq.set(ev.seq, ev); changed = true; }
              if (ev.seq < c.headSeq) c.headSeq = ev.seq;
              if (ev.seq > c.tailSeq) c.tailSeq = ev.seq;
            }
            c.hasMore = r.value.hasMore === true;
            if (changed || opts.beforeSeq !== undefined || opts.force === true) renderChatMessages(sessionId);
          }
          return c;
        }, [renderChatMessages]);
        /** 加载更早一页历史（向上翻）：beforeSeq=当前最早已加载 seq，prepend 并保持视口位置。 */
        const loadOlder = useCallback(async () => {
          const sid = stateRef.current.currentId;
          const c = chatCacheRef.current[sid];
          if (!c || !c.hasMore || c.loadingOlder || c.headSeq === Infinity) return;
          c.loadingOlder = true;
          loadingOlderRef.current = true;
          const el = chatRef.current;
          const prevHeight = el ? el.scrollHeight : 0;
          try {
            await loadTail(sid, { beforeSeq: c.headSeq });
            if (el) el.scrollTop += el.scrollHeight - prevHeight;
          } finally {
            c.loadingOlder = false;
            loadingOlderRef.current = false;
          }
        }, [loadTail]);
        const refreshModel = useCallback(async (sessionId) => {
          const r = await api('session.models', { sessionId });
          if (r && r.ok) setModel(r.value?.current?.model ?? '');
        }, []);
        // ============ 权限预设 + 审批（仿 DSH 本体 composer） ============
        /** 当前会话权限预设展示名（按 value 覆盖，其余回退 host name）。 */
        const PRESET_NAMES = { 'read-only': '只读', 'workspace-write': '工作区读写', 'danger-full-access': '完全访问 (Full access)' };
        const permNameOf = (v, fallback) => PRESET_NAMES[v] ?? fallback ?? String(v ?? '');
        /** 拉取某会话的权限预设状态（读 host ctx.permissionPresets 折叠）。 */
        const loadPerm = useCallback(async (sessionId) => {
          const r = await rpc('permission.state', { sessionId });
          //  修复（M2）：快速切换会话时旧响应不得覆盖新会话的权限预设（按响应 sessionId 校验）
          if (r && r.ok && r.value && r.value.available === true && String(r.value.sessionId ?? '') === sessionId) setPerm(r.value);
          else if (r && r.ok && r.value && r.value.available === false) setPerm(null);
        }, []);
        /** 切换当前会话权限预设（仿 /permission 命令；danger-full-access 在 UI 层先过确认）。 */
        const setPreset = async (preset) => {
          if (!stateRef.current.currentId || permBusy) return;
          setPermBusy(true);
          try {
            const r = await rpc('permission.set', { sessionId: stateRef.current.currentId, preset });
            if (r && r.ok) {
              showToast(`权限已切换：${permNameOf(preset)}`);
              setPermOpen(false);
              await loadPerm(stateRef.current.currentId);
            } else showToast(`切换失败：${(r && r.error) || '未知错误'}`);
          } catch (error) {
            showToast(`切换失败：${String(error?.message || error)}`);
          } finally { setPermBusy(false); }
        };
        /** 审批应答：把用户决定经 /api/respond（client-response 信封）回给宿主。
         *  与 DSH 本体 PendingWait.respond 同路径：{type:'client-response', rpcId, result:{ok,value}}。 */
        const answerApproval = async (item, outcome) => {
          if (!item || !item.rpcId || !item.approvalId) return;
          const message = {
            type: 'client-response',
            rpcId: item.rpcId,
            result: { ok: true, value: { sessionId: item.sessionId, approvalId: item.approvalId, outcome } },
          };
          try {
            // 优先走 connection.api.respond（客户端-响应专用通道）；无则退回裸 fetch
            let accepted = false;
            if (connection && connection.api && typeof connection.api.respond === 'function') {
              const receipt = await connection.api.respond(message);
              accepted = Boolean(receipt && receipt.accepted === true);
            } else {
              const res = await fetch('/api/respond', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(message),
              });
              const j = await res.json().catch(() => null);
              accepted = Boolean(j && j.accepted === true);
            }
            if (accepted) {
              setPendingApprovals((prev) => prev.filter((a) => a.approvalId !== item.approvalId || a.sessionId !== item.sessionId));
              showToast(outcome === 'allowed-once' ? '已允许一次' : '已拒绝');
            } else {
              // 未受理（可能已过期/被另一标签页处理）→ 也移出本地列表，避免残留卡片
              setPendingApprovals((prev) => prev.filter((a) => a.approvalId !== item.approvalId || a.sessionId !== item.sessionId));
            }
          } catch (error) {
            showToast(`审批应答失败：${String(error?.message || error)}`);
          }
        };
        /** 审批卡列表（当前会话 + 主会话的待审批都渲染；answerApproval 按 approvalId/sessionId 应答）。 */
        const approvalCardsOf = (items) => {
          if (!Array.isArray(items) || items.length === 0) return null;
          return items.map((item) => e('div', { key: `${item.sessionId}:${item.approvalId}`, className: 'arc-aprv-card' },
            e('div', { className: 'arc-aprv-strip' },
              e('span', { className: 'dot' }),
              '等待审批',
              item.toolName ? e('span', { className: 'tl' }, ` · ${item.toolName}`) : null),
            e('div', { className: 'arc-aprv-body' }, item.reason || `工具 ${item.toolName || '未知'} 请求越权执行`),
            e('div', { className: 'arc-aprv-actions' },
              e('button', { className: 'arc-btn danger', onClick: () => void answerApproval(item, 'rejected') }, '拒绝'),
              e('button', { className: 'arc-btn primary', onClick: () => void answerApproval(item, 'allowed-once') }, '允许一次'),
            ),
          ));
        };

        // ============ 流式输出：/api/events.mux SSE 实时事件 ============
        // 与 DSH 本体同源：打开流即收到全部会话的 session/subscribed（尾部 seq）+ 实时 session/event；
        // assistant/chunk 增量累积为 inFlight 条目（思考/回答逐字出现，思考区默认折叠、展开可见增长）。
        const handleMuxFrame = useCallback((raw) => {
          // WebSocket 消息是 server-request 信封 {type, rpcId, method, payload}，payload 才是 muxFrame
          const f = (raw && typeof raw === 'object' && raw.payload && typeof raw.payload === 'object') ? raw.payload : raw;
          if (!f || typeof f !== 'object') return;
          //  审批帧（与 DSH 本体同源，随 events.mux 广播）：approval/requested 进待审批
          // 列表（渲染在输入区上方），approval/resolved 移除；审批在"轮询模式"下也保持实时。
          const envRpcId = (raw && typeof raw === 'object' && typeof raw.rpcId === 'string') ? raw.rpcId : undefined;
          if (f.type === 'approval/requested') {
            if (typeof f.approvalId !== 'string' || typeof f.sessionId !== 'string' || !envRpcId) return;
            setPendingApprovals((prev) => prev.some((a) => a.approvalId === f.approvalId && a.sessionId === f.sessionId)
              ? prev
              : [...prev, { rpcId: envRpcId, sessionId: f.sessionId, approvalId: f.approvalId, toolName: String(f.toolName ?? ''), reason: typeof f.reason === 'string' ? f.reason : '' }]);
            return;
          }
          if (f.type === 'approval/resolved') {
            setPendingApprovals((prev) => prev.filter((a) => !(a.approvalId === f.approvalId && a.sessionId === f.sessionId)));
            return;
          }
          //  修复（H1）：乐观占位清理必须与流式开关无关——轮询模式（流式关闭）下
          // 真实 user/message 帧若被下方 streaming gate 拦下，占位永远清不掉 → 与 loadTail 落库的
          // 真实消息双份显示 + 恒显"发送中…"。此处先于 gate 完成两模式共用的清理（渲染层另有去重兜底）。
          if (f.type === 'session/event') {
            const sid = String(f.sessionId ?? '');
            const ev = f.event;
            if (ev?.type === 'user/message') {
              const blocks = Array.isArray(ev.data?.content) ? ev.data.content : Array.isArray(ev.data?.message?.content) ? ev.data.message.content : [];
              const txt = blocks.map((b) => (b?.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
              // 与下方流式分支同款前缀匹配（乐观条目 text 可能含图片 markdown 引用）
              if (txt) optimisticRef.current = optimisticRef.current.filter((o) => !(o.sid === sid && (o.text === txt || o.text.startsWith(txt))));
            }
          }
          // 流式关闭（轮询模式）：聊天渲染交给轮询 loadTail，会话帧不再驱动 UI；审批帧已在上方处理
          if (!streamingRef.current) return;
          if (f.type === 'session/event') {
            const sid = String(f.sessionId ?? '');
            const ev = f.event;
            if (!ev || typeof ev.seq !== 'number') return;
            const c = chatCacheRef.current[sid] ?? (chatCacheRef.current[sid] = { bySeq: new Map(), hasMore: true, headSeq: Infinity, tailSeq: -1 });
            if (ev.type === 'assistant/chunk') {
              if (sid !== stateRef.current.currentId) return;
              const chunk = ev.data?.chunk;
              const turn = ev.data?.turn;
              const step = ev.data?.step;
              const fl = inFlightRef.current;
              if (!fl || fl.turn !== turn || fl.step !== step) {
                inFlightRef.current = { turn, step, text: '', reasoning: '', tools: [], time: ev.time ?? 0 };
              }
              const cur = inFlightRef.current;
              if (chunk?.type === 'text-delta' && chunk.text) cur.text += chunk.text;
              else if (chunk?.type === 'reasoning-delta' && chunk.text) cur.reasoning += chunk.text;
              else if (chunk?.type === 'tool-call-delta' && chunk.name && !HIDDEN_STATE_TOOLS.includes(chunk.name) && !cur.tools.includes(chunk.name)) cur.tools.push(String(chunk.name).slice(0, 80));
              cur.time = ev.time ?? cur.time;
              markReplying(true);
              renderChatRef.current?.(sid);
              return;
            }
            if (!c.bySeq.has(ev.seq)) {
              c.bySeq.set(ev.seq, ev);
              if (ev.seq < c.headSeq) c.headSeq = ev.seq;
              if (ev.seq > c.tailSeq) c.tailSeq = ev.seq;
            }
            if (sid !== stateRef.current.currentId) return;
            if (ev.type === 'assistant/message') {
              const d = ev.data ?? {};
              const fl = inFlightRef.current;
              if (fl && fl.turn === d.turn && fl.step === d.step) inFlightRef.current = null;
              markReplying(false);
              renderChatRef.current?.(sid);
            } else if (ev.type === 'user/message') {
              const blocks = Array.isArray(ev.data?.content) ? ev.data.content : Array.isArray(ev.data?.message?.content) ? ev.data.message.content : [];
              const txt = blocks.map((b) => (b?.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
              // 乐观条目 text 可能含图片 markdown 引用（真实事件仅 text blocks）→ 用前缀匹配移除占位
              if (txt) optimisticRef.current = optimisticRef.current.filter((o) => !(o.sid === sid && (o.text === txt || o.text.startsWith(txt))));
              renderChatRef.current?.(sid);
            } else if (ev.type === 'turn/end') {
              markReplying(false);
              renderChatRef.current?.(sid);
            }
          }
        }, []);
        /** 建立/维持 /api/events.mux WebSocket 流（与流式开关解耦： 起审批帧需要
         *  常驻通道，流式关闭时仍保持连接，仅"聊天渲染"回退轮询；断开 3s 自动重连）。
         *  与 DSH 本体同源：浏览器端 mux 是 WebSocket 下行（非 SSE fetch），消息=server-request 信封 JSON。 */
        const ensureStream = useCallback(() => {
          if (streamAbortRef.current || typeof location === 'undefined') return;
          let ws = null;
          let closed = false;
          let retryTimer = null;
          const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events.mux`;
          const stop = () => {
            //  修复（低危）：卸载/中止时同时清掉已排期的 3s 重连定时器，
            // 否则插件停用后 setTimeout 仍触发 ensureStream → 后台空转重建 WebSocket。
            if (retryTimer !== null) { try { clearTimeout(retryTimer); } catch { /* ignore */ } retryTimer = null; }
            if (ws) { try { ws.onmessage = null; ws.onclose = null; ws.onerror = null; ws.close(); } catch { /* ignore */ } }
            ws = null;
          };
          streamAbortRef.current = { abort: () => { closed = true; stop(); } };
          const retry = () => {
            if (closed) return;
            retryTimer = setTimeout(() => { retryTimer = null; ensureStream(); }, 3000); // 自动重连
          };
          try {
            ws = new WebSocket(url);
            ws.onmessage = (ev) => {
              if (typeof ev.data !== 'string') return;
              try { handleMuxFrame(JSON.parse(ev.data)); } catch { /* 单帧损坏跳过 */ }
            };
            ws.onclose = () => {
              streamAbortRef.current = null;
              if (!closed) retry();
            };
            ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
          } catch { /* 构造失败 */ }
        }, [handleMuxFrame]);
        /** 流式开关（settings 持久化）：开=实时增量渲染聊天；关=聊天回退轮询（审批帧仍实时，
         *  连接保持——见 ensureStream 注释）。 */
        const toggleStreaming = async () => {
          const next = !streamingRef.current;
          streamingRef.current = next;
          setStreaming(next);
          const r = await rpc('ui.settings.set', { streaming: next });
          if (r && !r.ok) showToast(`保存设置失败：${r.error}`);
          inFlightRef.current = null;
          void loadTail(stateRef.current.currentId, { force: true }); // 切换渲染源后必须重渲染
          showToast(next ? '已开启流式输出（思考/回答实时显示）' : '已关闭流式输出（消息按轮询刷新，审批仍实时）');
        };

        // 自动滚动到底（长会话时新消息不再落在视口外）；
        //  修复"翻阅历史被拉回底部"：仅在用户位于底部附近时跟随滚动
        useEffect(() => {
          const el = chatRef.current;
          if (el && stickRef.current) el.scrollTop = el.scrollHeight;
        }, [messages, page]);

        //  修复"打开功能页总不在顶部"：主区内容滚动容器由 chat 与功能页两分支
        // 复用同一 DOM 节点（同类型 div、无 key），切换时 scrollTop 会残留——聊天停在底部或
        // 上一功能页翻到中部时，新打开的思维循环等页就落在中途/底部。
        // 修复：每次进入功能页都把内容区回到顶部（useLayoutEffect 在绘制前清零，无闪帧）；
        // chat 页滚动由既有 stickRef/自动滚底逻辑管理（返回会话时强制从底部开始），不受影响。
        useLayoutEffect(() => {
          if (page === 'chat') return;
          const el = pageRef.current;
          if (el) el.scrollTop = 0;
        }, [page]);

        // 轮询刷新（ 优化）：页面可见 3s 一次，隐藏（切后台/挂起）降频 30s——省电不丢消息；
        // 流式开启时 SSE 已实时覆盖，轮询降频 10s 仅作兜底（断流/漏帧由下一次拉取补齐）；
        // 切回前台（visibilitychange）立即刷新一次。初始化：读取流式开关并启动 SSE。
        useEffect(() => {
          void refreshSidebar();
          void loadTail(stateRef.current.currentId, { force: true }); // 初始化：强制渲染缓存
          void refreshModel(stateRef.current.currentId);
          void loadPerm(stateRef.current.currentId); //：初始化权限预设（主会话）
          (async () => {
            const r = await rpc('ui.settings.get');
            if (r.ok && r.value && typeof r.value.streaming === 'boolean') {
              streamingRef.current = r.value.streaming;
              setStreaming(r.value.streaming);
            }
            //：mux 常驻（审批帧实时），不随流式开关启停——仅聊天渲染由 streamingRef 控制
            ensureStream();
          })();
          let alive = true;
          let t = 0;
          const tick = async () => {
            if (!alive) return;
            await refreshSidebar();
            await loadTail(stateRef.current.currentId, { probeOnly: true }); //：探测增量，无新增不拉全量（1.85MB→17KB）
            await refreshModel(stateRef.current.currentId);
            //  人格一致性渲染层映射（15s 节流拉取，本地服务开销极低）
            if (Date.now() - lastConsistencyPullRef.current > 15000) {
              lastConsistencyPullRef.current = Date.now();
              const cr = await rpc('consistency.revisions');
              //  性能修复：服务端为 seqMap 配了单调 rev，未变化时直接跳过。
              // 原实现每 15s 无条件 renderChatRef → 重建全部消息对象并整段聊天重渲染。
              const rev = (cr.ok && cr.value && typeof cr.value === 'object') ? (cr.value.rev ?? null) : null;
              if (cr.ok && cr.value?.map && typeof cr.value.map === 'object' && rev !== lastConsistencyRevRef.current) {
                lastConsistencyRevRef.current = rev;
                consistencyMapRef.current = cr.value.map;
                renderChatRef.current?.(stateRef.current.currentId);
              }
            }
            const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
            const interval = hidden ? 30000 : (streamingRef.current ? 10000 : 3000);
            t = setTimeout(tick, interval);
          };
          t = setTimeout(tick, 3000);
          const onVis = () => { if (typeof document !== 'undefined' && !document.hidden) void refreshSidebar(); };
          if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
          return () => { alive = false; clearTimeout(t); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis); };
        }, [refreshSidebar, loadTail, refreshModel, ensureStream, rpc]);

        // 首次交互解锁提示音（浏览器自动播放策略）
        useEffect(() => {
          const unlock = () => { try { playBeep(); } catch { /* 忽略 */ } };
          if (typeof document !== 'undefined') {
            document.addEventListener('pointerdown', unlock, { once: true });
            return () => document.removeEventListener('pointerdown', unlock);
          }
        }, []);

        // 组件卸载：断开 SSE 流（防页面关闭后连接残留）
        useEffect(() => () => {
          if (streamAbortRef.current) { try { streamAbortRef.current.abort(); } catch { /* ignore */ } }
          streamAbortRef.current = null;
        }, []);

        const openSession = async (id) => {
          setCurrentId(id);
          setPage('chat');
          setMessages([]);
          markReplying(false); // （L7）：切会话清"回复中"并撤掉旧 60s 兜底 timer
          inFlightRef.current = null; // 切换会话：流式增量按会话隔离
          stickRef.current = true; // 切换会话后从底部开始
          setPermOpen(false);
          //：待审批保留（approval/resolved 帧到达时自行移除）；渲染时按当前/主会话过滤
          await loadTail(id, { force: true }); // force：已清空显示，必须重渲染（缓存无新事件时也不例外）
          await refreshModel(id);
          void loadPerm(id); //：会话级权限预设（permission 逐会话独立）
        };
        // 新建会话（选择工作区/指定文件夹）：原生 session.create({workspaceId}) → 打开新会话并刷新侧栏
        const createSession = async (workspaceId) => {
          try {
            let wsId = workspaceId || newWsId;
            // 弹窗未选择/未填路径时，默认用第一个工作区（与弹窗 select 显示一致， 修复"请选择工作区"）
            if (!wsId && !newWsPath.trim() && Array.isArray(workspaces) && workspaces.length > 0) wsId = workspaces[0].workspaceId;
            // 未选现有工作区但填了路径 → 先用原生 workspace.create 把目录建为新工作区（支持项目外路径）
            if (!wsId && newWsPath.trim()) {
              const wr = await api('workspace.create', { path: newWsPath.trim() });
              if (wr && wr.ok && wr.value?.workspace?.workspaceId) {
                wsId = wr.value.workspace.workspaceId;
              } else {
                showToast(`工作区创建失败（目录需已存在）：${(wr && wr.error) || ''}`);
                return;
              }
            }
            if (!wsId) { showToast('请选择工作区或输入文件夹路径'); return; }
            const r = await api('session.create', { workspaceId: wsId });
            if (r && r.ok && r.value?.sessionId) {
              const sid = r.value.sessionId;
              newlyCreatedRef.current[sid] = Date.now();
              //  修复：session.create（connection/api-gateway 通道）创建后不 attach 工作区，
              // 由 Host 侧补 attach（workspaceRegistry），否则侧栏永远看不到新会话
              const at = await rpc('workspace.attach', { workspaceId: wsId, sessionId: sid });
              if (!at.ok) showToast(`会话已创建，但挂载工作区失败：${at.error}`);
              // 强制展开所属工作区——若用户折叠过工作区，新建后不展开就看不到会话行
              setWsExpanded((prev) => ({ ...prev, [wsId]: true }));
              showToast('已创建会话');
              try { console.log('[arc-create] sid=', sid, 'ws=', wsId, 'attach=', at.ok); } catch { /* ignore */ }
              setNewWsPath('');
              await refreshSidebar();
              await openSession(sid);
              await refreshSidebar(); // 再次刷新，确保新会话出现在侧栏
            } else {
              showToast(`创建失败：${(r && r.error) || '未知错误'}`);
            }
          } catch (error) {
            showToast(`创建会话异常：${String(error?.message || error)}`);
          }
        };
        //  类似 DSH 原生的工作区目录选择——调用宿主 native 目录选择器
        // （Windows 系统文件夹对话框 IFileOpenDialog），选中路径后走 workspace.create 建新工作区。
        //  手机端修复：无系统对话框的环境（Linux/proot）能力为 browse——
        // 先探测 capability，native 走系统对话框，browse 打开自绘目录浏览弹窗。
        const pickDirectory = async () => {
          if (pickingDir) return;
          setPickingDir(true);
          try {
            const cap = await rpc('directory.capability', {});
            const kind = cap && cap.ok ? (cap.value?.kind ?? 'unavailable') : 'unavailable';
            if (kind === 'native') {
              const r = await rpc('directory.pick', {});
              if (r && r.ok) {
                if (r.value?.path) { setNewWsPath(String(r.value.path)); setNewWsId(''); }
                // path===null = 用户取消，不提示
              } else {
                showToast(`目录选择失败：${(r && r.error) || '未知错误'}`);
              }
            } else if (kind === 'browse') {
              setBrowseOpen(true);
            } else {
              showToast('目录选择服务不可用：可手动在输入框填写目录路径');
            }
          } catch (error) {
            showToast(`目录选择失败：${String(error?.message || error)}`);
          } finally {
            setPickingDir(false);
          }
        };
        const sendText = async (text) => {
          const t = String(text ?? '').trim();
          const imgRefs = pasteImgs.map((p) => p.markdown);
          const finalText = [t, ...imgRefs].filter(Boolean).join('\n').trim();
          if (!finalText || !stateRef.current.currentId) return false;
          const sid = stateRef.current.currentId;
          //  UX 修复：点击发送即刻上屏——乐观占位改为在第一个 await 之前同步插入，
          // 上屏不再等待 session.prompt 的服务端处理（唤醒/入队/忙时排队时延不定，曾导致消息
          // 时快时慢地延迟出现）。checkReady / session.prompt 改为其后异步投递：
          //  - 成功：占位保留，待真实 user/message 事件（mux 或轮询落库）按文本匹配替换（渲染层有去重兜底）；
          //  - 任一环节失败：按本条 uid 移除占位并提示（输入框内容由调用方保留，可直接重发）。
          stickRef.current = true; // 发送后跟随滚动到底
          const uid = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          // 会话缓存兜底：renderChatMessages 无缓存时直接 return（新建/尚未加载过的会话若缺缓存，
          // 乐观占位会被渲染跳过 → 消息直到 900ms 轮询兜底才出现）。此处确保缓存存在使占位必上屏。
          if (!chatCacheRef.current[sid]) chatCacheRef.current[sid] = { bySeq: new Map(), hasMore: true, headSeq: Infinity, tailSeq: -1 };
          optimisticRef.current = [...optimisticRef.current, { sid, text: finalText, time: Date.now(), uid }];
          renderChatRef.current?.(sid);
          const dropOptimistic = () => { // 失败回滚：仅移除本条占位（uid 精确匹配，不影响并发发送的其他占位）
            optimisticRef.current = optimisticRef.current.filter((o) => o.uid !== uid);
            renderChatRef.current?.(sid);
          };
          //：未配置模型提供商拦截——直接不发送并提示（避免发送后静默无回应）。
          // 仅当 Host 明确判定未配置（ok && configured===false）才拦截；RPC 自身异常/服务不可用时放行，
          // 让 session.prompt 正常报错，避免误拦截导致消息永远发不出去。
          const ready = await rpc('models.checkReady', {});
          if (ready && ready.ok && ready.value && ready.value.configured === false) {
            dropOptimistic();
            setPasteImgs([]);
            showToast('未配置模型提供商：请先在「模型」页配置 DeepSeek 密钥或自定义提供商后再发送');
            return false; //  修复（L6）：返回未投递——输入框内容保留，用户配好密钥可直接重发
          }
          const r = await api('session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: finalText }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
          if (r && r.ok) {
            setPasteImgs([]);
            //：乐观上屏——占位已在上方（不等 RPC）插入；这里不再移除占位，
            // 真实 user/message 事件到达后按文本匹配移除占位条目（渲染层另有去重兜底）。
            showToast(imgRefs.length > 0 ? '已发送（含图片，AI 将自动识别）' : '已发送，AI 回复中…');
            markReplying(true); // （L7）：内部按"最后活动 +60s 无信号"计时，多次发送不叠加旧 timer
            // 兜底：SSE 未开/断流时按轮询补齐（探测增量，无新增则跳过）
            setTimeout(() => { void loadTail(sid, { probeOnly: true }); }, 900);
            return true; // 已投递 → 调用方清空输入
          }
          dropOptimistic();
          showToast(`发送失败：${(r && r.error) || ''}`);
          return false; // （L6）：失败也保留输入，避免误清空待重发内容
        };
        // 停止生成（仿 DSH 原生停止——原生 API session.cancel）
        const stopGenerate = async () => {
          if (!stateRef.current.currentId) return;
          const r = await api('session.cancel', { sessionId: stateRef.current.currentId });
          if (r && r.ok) { markReplying(false); inFlightRef.current = null; showToast('已停止生成'); setTimeout(() => { void loadTail(stateRef.current.currentId, { force: true }); }, 600); }
          else showToast(`停止失败：${(r && r.error) || ''}`);
        };
        // 上传图片（describe-image attach 通道；：加入"待发送"预览条，随消息一起发送，AI 收到引用后自行调 describe_image 识图）
        const uploadImage = async (file) => {
          if (!file) return;
          if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) { showToast('仅支持 PNG/JPEG/GIF/WebP'); return; }
          if (file.size > 10 * 1024 * 1024) { showToast('图片超过 10 MB 上限'); return; }
          setUploading(true);
          try {
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result ?? ''));
              reader.onerror = () => reject(new Error('读取文件失败'));
              reader.readAsDataURL(file);
            });
            const comma = dataUrl.indexOf(',');
            if (comma < 0) throw new Error('读取文件失败');
            const resp = await fetch('/describe-image/attach', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ data: dataUrl.slice(comma + 1), mediaType: file.type, name: file.name }),
            });
            const env = await resp.json().catch(() => null);
            if (env && env.ok && env.value?.markdown) {
              const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
              setPasteImgs((prev) => [...prev, { key, markdown: env.value.markdown, thumb: dataUrl }]);
              showToast('图片已加入待发送（Enter 发送后 AI 自动识别）');
            } else {
              showToast(`上传失败：${(env && env.error?.message) || '图片通道不可用'}`);
            }
          } catch (err) {
            showToast(`上传失败：${String(err?.message || err)}`);
          } finally { setUploading(false); }
        };
        // 粘贴图片到输入框（剪贴板图片直接进入待发送预览条）
        const onPaste = (ev) => {
          const files = ev.clipboardData?.files;
          if (!files || files.length === 0) return;
          for (const f of files) {
            if (f.type && f.type.startsWith('image/')) {
              ev.preventDefault();
              void uploadImage(f);
              return;
            }
          }
        };
        // 删除会话（普通会话/归档会话；主会话不可删）
        const deleteSession = (sid) => {
          const title = sid === MAIN_SESSION_ID ? '主会话' : (sessions.find((s) => s.sessionId === sid)?.projections?.values?.title || sid);
          askConfirm(`删除会话「${truncate(String(title), 40)}」？\n将同时删除其持久化记录，不可恢复。`, async () => {
            const r = await rpc('system.purgeSession', { id: sid });
            if (r.ok) {
              showToast('会话已删除');
              await refreshSidebar();
              if (stateRef.current.currentId === sid) { setCurrentId(MAIN_SESSION_ID); setPage('chat'); setMessages([]); inFlightRef.current = null; await loadTail(MAIN_SESSION_ID, { force: true }); }
            } else showToast(`删除失败：${r.error}`);
          });
        };
        // 重命名会话（原生 session.rename）
        const renameSession = (sid) => {
          const title = sid === MAIN_SESSION_ID ? '主会话' : (sessions.find((s) => s.sessionId === sid)?.projections?.values?.title || '');
          setRenaming({ id: sid, title: String(title) });
        };
        const saveRename = async () => {
          if (!renaming) return;
          const title = renaming.title.trim();
          if (!title) { showToast('标题不能为空'); return; }
          const r = await api('session.rename', { sessionId: renaming.id, title });
          if (r && r.ok) { showToast(`已重命名为「${r.value?.title ?? title}」`); setRenaming(null); await refreshSidebar(); }
          else showToast(`重命名失败：${(r && r.error) || ''}`);
        };
        const gotoFeature = (p) => setPage(p);

        // 关闭：通知 Host 保存全部会话并退出进程 → 尝试关闭本页（进程退出后端口自动释放）
        const doShutdown = async () => {
          if (shuttingDown) return;
          setShuttingDown(true);
          showToast('正在保存数据并关闭服务…');
          let failed = false;
          try {
            const r = await Promise.race([
              rpc('system.shutdown', {}),
              //  Host 关闭前若备份进行中会等待最长 60s——2.5s 超时会把
              // "正常关闭中"误报为失败；提到 65s 与 Host 最大等待一致
              new Promise((res) => setTimeout(() => res({ ok: false, error: '超时（服务未响应）' }), 65000)),
            ]);
            if (!r || !r.ok) { failed = true; showToast(`关闭失败：${(r && r.error) || '未知错误'}`); }
          } catch (err) {
            failed = true;
            showToast(`关闭失败：${String(err && err.message || err)}`);
          }
          if (!failed) {
            try { window.close(); } catch { /* 浏览器可能拦截 */ }
            setTimeout(() => {
              showToast('服务已关闭，3081 端口已释放；可手动关闭此标签页');
              setShuttingDown(false);
            }, 900);
          } else {
            setShuttingDown(false); // 失败：恢复按钮，提示真实原因
          }
        };

        const isMain = currentId === MAIN_SESSION_ID;
        const featureTitle = { persona: '人格', loop: '思维循环', memory: '记忆', evolution: '自进化', consistency: '人格一致性', schedule: '定时任务', notify: '通知', vision: '识图', report: '每日简报', tools: '工具与技能', models: '模型提供商', overview: '总控' }[page] ?? '';

        return e('div', { className: 'arc-app' },
          // ===== 侧栏 =====
          e('div', { className: 'arc-sb' },
            e('div', { className: 'arc-brand' },
              e('span', { className: 'dot' }),
              e('div', null, e('div', { className: 'nm' }, 'DSH-ARCHIVE'), e('div', { className: 'st' }, truncate(status, 24))),
            ),
            e('button', { className: 'arc-main-btn', onClick: () => void openSession(MAIN_SESSION_ID) }, '★ 主对话'),
            e('div', { className: 'arc-feats' },
              FEATURES.map(([id, label, icon]) => e('button', { key: id, className: `arc-feat${page === id ? ' on' : ''}${id === 'notify' && unread > 0 ? ' has-unread' : ''}`, onClick: () => gotoFeature(id) },
                e('span', { className: 'ic' }, icon), e('span', null, label),
                id === 'notify' && unread > 0 ? e('span', { className: 'arc-dot', title: `${unread} 条未读` }) : null)),
            ),
            // ---- 主会话栏（上部：始终固定一个会话）----
            e('div', { className: 'arc-mainsec' },
              e('div', { className: 'arc-sech' }, e('span', null, '主会话'), e('span', null, '固定')),
              e('div', { className: `arc-mainrow${currentId === MAIN_SESSION_ID ? ' on' : ''}`, onClick: () => void openSession(MAIN_SESSION_ID) },
                e('span', { style: { color: 'var(--arc-warn)', flex: 'none' } }, '★'),
                e('span', { className: 'arc-ws-t' }, '主会话'),
                e('span', { className: 'arc-ws-m' }, '总会话'),
              ),
            ),
            // ---- 工作区（下部：按工作区分组，参照 DSH 原生浏览设计）----
            e('div', { className: 'arc-ws' },
              e('div', { className: 'arc-sech' }, e('span', null, '工作区'), e('span', null, String(workspaces.length))),
              e('div', { className: 'arc-ws-scroll' },
                workspaces.map((w) => {
                  const open = wsExpanded[w.workspaceId] !== false;
                  // 仿 DSH 原生：空白会话（未对话）仅当前选中时显示，切走即自动从栏中清除；
                  // 例外：最近新建的会话（60s 内）始终显示，避免新建后看不到
                  const wsSessions = (w.sessionIds ?? []).filter((sid) => {
                    if (sid === MAIN_SESSION_ID) return false;
                    const it = sessions.find((s) => s.sessionId === sid);
                    if (isNewlyCreated(sid)) return true;
                    return !(it && it.blank === true && sid !== currentId);
                  });
                  return e('div', { key: w.workspaceId, style: { marginBottom: 2 } },
                    e('div', { className: 'arc-wsh', onClick: () => toggleWs(w.workspaceId), title: w.path },
                      e('span', { className: `arc-ws-chev${open ? ' open' : ''}` }, '▸'),
                      e('span', { className: 'arc-ws-t' }, wsTitleOf(w)),
                      e('span', { className: 'arc-ws-m' }, truncate(String(w.path ?? '').replace(/\\/g, '/'), 22)),
                      e('button', { className: 'arc-ws-add', title: '在此工作区新建会话', onClick: (ev) => { ev.stopPropagation(); void createSession(w.workspaceId); } }, '＋')),
                    open && wsSessions.map((sid) => {
                      const item = sessions.find((s) => s.sessionId === sid);
                      return e('div', { key: sid, className: `arc-wss${sid === currentId ? ' on' : ''}`, onClick: () => void openSession(sid) },
                        e('span', { className: 'arc-ws-t' }, sessionTitleOf(item)),
                        e('span', { className: 'arc-ws-m' }, item ? fmtTime(item.updatedAt) : ''),
                        e('button', { className: 'arc-del', title: '重命名会话', onClick: (ev) => { ev.stopPropagation(); renameSession(sid); } }, '✎'),
                        e('button', { className: 'arc-del', title: '删除会话', onClick: (ev) => { ev.stopPropagation(); deleteSession(sid); } }, '✕'));
                    }),
                  );
                }),
                archivedIds.filter((sid) => {
                  if (isNewlyCreated(sid)) return true;
                  const it = sessions.find((s) => s.sessionId === sid);
                  return !(it && it.blank === true && sid !== currentId);
                }).length > 0 && e('div', { style: { marginTop: 6 } },
                  e('div', { className: 'arc-sech', style: { paddingBottom: 4 } }, e('span', null, `归档 (${archivedIds.length})`)),
                  archivedIds.filter((sid) => {
                    if (isNewlyCreated(sid)) return true;
                    const it = sessions.find((s) => s.sessionId === sid);
                    return !(it && it.blank === true && sid !== currentId);
                  }).map((sid) => {
                    const item = sessions.find((s) => s.sessionId === sid);
                    return e('div', { key: sid, className: 'arc-wss', onClick: () => void openSession(sid) },
                      e('span', { className: 'arc-ws-t' }, sessionTitleOf(item)),
                      e('span', { className: 'arc-ws-m' }, '归档'),
                      e('button', { className: 'arc-del', title: '重命名会话', onClick: (ev) => { ev.stopPropagation(); renameSession(sid); } }, '✎'),
                      e('button', { className: 'arc-del', title: '删除会话', onClick: (ev) => { ev.stopPropagation(); deleteSession(sid); } }, '✕'));
                  })),
                workspaces.length === 0 && e('p', { className: 'arc-note', style: { padding: 8 } }, '暂无工作区'),
              ),
            ),
            e('div', { className: 'arc-sb-foot' },
              e('button', { onClick: () => setNewSessionOpen(true) }, '＋ 新建会话'),
              e('button', { onClick: async () => { await refreshSidebar(); await loadTail(stateRef.current.currentId, { force: true }); showToast('已刷新'); } }, '↻ 刷新'),
              e('button', { onClick: () => gotoFeature('overview') }, '总控'),
            ),
          ),
          // ===== 主区 =====
          e('div', { className: 'arc-main' },
            e('div', { className: 'arc-top' },
              e('span', { className: 't' }, page === 'chat' ? (isMain ? '★ 主对话' : truncate(sessionTitleOf(sessions.find((s) => s.sessionId === currentId)), 26)) : featureTitle),
              e('span', { className: 's' }, page === 'chat' ? (isMain ? '总会话 · 主动消息与定时提醒送达于此' : '普通会话 · 与其他会话一致') : '智能体管理'),
              model ? e('span', { className: 'm' }, model) : null,
              e('button', { className: 'arc-stream-toggle', title: streaming ? '流式输出：开（思考/回答实时逐字显示）— 点击关闭' : '流式输出：关（仅轮询刷新）— 点击开启', onClick: () => void toggleStreaming() }, streaming ? '⚡ 流式' : '⏸ 轮询'),
              e('button', { className: 'arc-shutdown', onClick: () => void doShutdown(), disabled: shuttingDown, title: '保存数据并关闭服务（释放 3081 端口）' },
                e('span', null, '⏻'),
                e('span', null, shuttingDown ? '关闭中…' : '关闭')),
            ),
            page === 'chat'
              ? e('div', { className: 'arc-chat', ref: chatRef, onScroll: onChatScroll },
                  messages.length === 0
                    ? e(Empty, { icon: '💬', text: isMain ? '主对话 · 开始吧' : '开始对话吧', sub: '输入内容并回车发送，AI 会实时回复' })
                    : [
                        (chatCacheRef.current[currentId]?.hasMore ?? false)
                          ? e('div', { key: 'more', className: 'arc-note', style: { textAlign: 'center', padding: '6px 0' } },
                              e('button', { className: 'arc-btn small', onClick: () => void loadOlder(), disabled: loadingOlderRef.current }, loadingOlderRef.current ? '加载中…' : '↑ 加载更早消息'))
                          : null,
                        ...messages.map((m, i) =>
                          e('div', { key: m.key ?? i, className: `arc-msg ${m.role === 'user' ? 'user' : m.role === 'system' ? 'sys' : 'ai'}${m.streaming ? ' streaming' : ''}${m.intercepted ? ' intercepted' : ''}` },
                            e('div', { className: 'who' }, `${m.role === 'user' ? '你' : m.role === 'system' ? '系统' : 'AI'}${m.optimistic ? '（发送中…）' : ''} · ${fmtTime(m.time)}${m.streaming ? ' · 生成中…' : ''}`),
                            m.intercepted
                              ? e('div', { className: 'arc-note', style: { color: 'var(--arc-err)', fontWeight: 600, marginBottom: 4 } }, '⛔ 人格一致性拦截：该回复因人格严重突变被拒绝采用（原文见「一致性」页拦截记录，下方为按进化方向重新生成的回复）')
                              : null,
                            m.revised
                              ? e('div', { className: 'arc-note', style: { color: 'var(--arc-warn)', marginBottom: 4 } }, '✏️ 人格平滑修正：已按近期人格轨迹调整表述')
                              : null,
                            m.role === 'assistant' && m.reasoning
                              ? e('details', { className: 'arc-reason' },
                                  e('summary', null, '🧠 思考过程'),
                                  e('div', { className: 'arc-reason-body' }, renderMessage(m.reasoning) ?? m.reasoning))
                              : null,
                            m.role === 'assistant' && m.tools && m.tools.length > 0
                              ? e('div', { className: 'arc-tools' }, m.tools.map((t, j) => e('span', { key: j, className: 'arc-tool-chip' }, `🔧 ${t}`)))
                              : null,
                            m.text ? renderMessage(m.text) : (m.streaming ? e('div', { className: 'arc-note' }, '…') : null))),
                      ],
                  replying && e('div', { className: 'arc-note', style: { textAlign: 'center', padding: '4px 0', color: 'var(--arc-faint)' } }, 'AI 思考中…'),
                )
              : e('div', { className: 'arc-page', ref: pageRef }, page === 'overview' ? e(PageOverview, { rpc, showToast, gotoFeature, askConfirm }) :
                  page === 'persona' ? e(PagePersona, { rpc, showToast, askConfirm }) :
                  page === 'loop' ? e(PageLoop, { rpc, showToast, askConfirm }) :
                  page === 'memory' ? e(PageMemory, { rpc, showToast, askConfirm }) :
                  page === 'evolution' ? e(PageEvolution, { rpc, showToast, askConfirm }) :
                  page === 'consistency' ? e(PageConsistency, { rpc, showToast, askConfirm }) :
                  page === 'schedule' ? e(PageSchedule, { rpc, showToast, askConfirm }) :
                  page === 'notify' ? e(PageNotify, { rpc, showToast, askConfirm }) :
                  page === 'tools' ? e(PageTools, { rpc, showToast }) :
                  page === 'models' ? e(PageModels, { rpc, showToast }) :
                  page === 'vision' ? e(PageVision, { rpc, showToast }) :
                  page === 'report' ? e(PageReport, { rpc, showToast }) : null),
            page === 'chat' && [
              //  审批卡（当前会话 + 主会话待审批；仅当有请求时显示）
              (() => {
                const pend = pendingApprovals.filter((a) => a.sessionId === stateRef.current.currentId || a.sessionId === MAIN_SESSION_ID);
                const cards = approvalCardsOf(pend);
                return cards ? e('div', { key: 'aprv', className: 'arc-aprv-wrap' }, cards) : null;
              })(),
              //  权限预设选择（仿 DSH 本体 composer 的访问模式；仅会话可用时显示）
              (perm && perm.available === true
                ? e('div', { key: 'permrow', className: 'arc-perm-row' },
                    e('span', { className: 'lbl' }, '访问模式'),
                    e('div', { className: 'arc-perm-wrap' },
                      e('button', {
                        className: `arc-perm-pill${perm.current === 'danger-full-access' ? ' full' : ''}`,
                        title: '切换沙箱权限预设（read-only / workspace-write / danger-full-access）',
                        onClick: () => setPermOpen((o) => !o),
                        disabled: permBusy,
                      }, `🛡 ${permNameOf(perm.current, perm.current)}${permOpen ? ' ▴' : ' ▾'}`),
                      permOpen
                        ? e('div', { className: 'arc-perm-menu' },
                            (Array.isArray(perm.options) ? perm.options : []).map((o) => {
                              const active = o.value === perm.current;
                              return e('button', {
                                key: o.value,
                                className: `arc-perm-item${active ? ' on' : ''}${o.value === 'danger-full-access' ? ' full' : ''}`,
                                title: o.description || '',
                                disabled: permBusy,
                                onClick: () => {
                                  setPermOpen(false);
                                  if (active) return;
                                  if (o.value === 'danger-full-access') {
                                    // 与 DSH 本体一致：Full access 需显式风险确认
                                    askConfirm('确认启用 Full access？\n启用后 agent 将减少确认步骤，可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。',
                                      () => void setPreset(o.value));
                                  } else {
                                    void setPreset(o.value);
                                  }
                                },
                              }, permNameOf(o.value, o.name), active ? ' ✓' : '');
                            }),
                          )
                        : null,
                    ),
                  )
                : null),
              pasteImgs.length > 0 && e('div', { key: 'pastebar', className: 'arc-pastebar' },
                pasteImgs.map((p) => e('div', { key: p.key, className: 'arc-paste-item' },
                  e('img', { src: p.thumb, alt: '待发送图片' }),
                  e('button', { className: 'arc-paste-x', title: '移除', onClick: () => setPasteImgs((prev) => prev.filter((x) => x.key !== p.key)) }, '✕')))),
              e(ChatComposer, { key: 'inp', onPaste, sendText, replying, stopGenerate, uploading, fileRef, uploadImage }),
            ],
            e(LedgerDock, { showToast }),
          ),
          toast ? e('div', { className: 'arc-toast' }, toast) : null,
          //：功能页（非聊天）悬浮审批卡——主会话的主动/定时任务也可能触发审批
          (page !== 'chat' && (() => {
            const pend = pendingApprovals.filter((a) => a.sessionId === MAIN_SESSION_ID);
            const cards = approvalCardsOf(pend);
            return cards ? e('div', { key: 'aprvfloat', className: 'arc-aprv-float' }, cards) : null;
          })()),
          newSessionOpen ? e('div', { className: 'arc-confirm' },
            e('div', { className: 'box' },
              e('div', { className: 'msg' }, '新建会话 · 选择工作区'),
              e('select', { className: 'arc-sel', value: newWsId || (workspaces[0]?.workspaceId ?? ''), onChange: (ev) => { setNewWsId(ev.target.value); setNewWsPath(''); } },
                workspaces.map((w) => e('option', { key: w.workspaceId, value: w.workspaceId }, `${wsTitleOf(w)}  ·  ${String(w.path ?? '').replace(/\\/g, '/')}`))),
              e('div', { className: 'arc-row', style: { display: 'flex', alignItems: 'center', marginTop: 6 } },
                e('button', { className: 'arc-btn', disabled: pickingDir, title: '弹出系统文件夹选择对话框，挑选任意目录创建新工作区', onClick: () => void pickDirectory() }, pickingDir ? '选择中…' : '📁 浏览目录…'),
                newWsPath ? e('span', { className: 'arc-note', style: { marginLeft: 8, wordBreak: 'break-all', flex: 1 } }, String(newWsPath).replace(/\\/g, '/')) : null),
              e('div', { className: 'arc-note', style: { marginTop: 4 } }, '选择现有工作区，或点「浏览目录…」用系统选择器挑选任意文件夹创建新工作区；智能体与记忆全项目通用。'),
              e('div', { className: 'ops' },
                e('button', { className: 'arc-btn', onClick: () => setNewSessionOpen(false) }, '取消'),
                e('button', { className: 'arc-btn primary', onClick: () => { setNewSessionOpen(false); void createSession(); } }, '创建')))) : null,
          browseOpen ? e(BrowseModal, {
            rpc, showToast,
            onPick: (p) => { if (p) { setNewWsPath(String(p)); setNewWsId(''); } },
            onClose: () => setBrowseOpen(false),
          }) : null,
          confirm ? e('div', { className: 'arc-confirm' },
            e('div', { className: 'box' },
              e('div', { className: 'msg' }, confirm.msg),
              e('div', { className: 'ops' },
                e('button', { className: 'arc-btn', onClick: () => setConfirm(null) }, '取消'),
                e('button', { className: 'arc-btn primary', onClick: () => { const y = confirm.onYes; setConfirm(null); void y(); } }, '确认')))) : null,
          renaming ? e('div', { className: 'arc-confirm' },
            e('div', { className: 'box' },
              e('div', { className: 'msg' }, '重命名会话'),
              e('input', { className: 'arc-rename-input', value: renaming.title, placeholder: '新标题', autoFocus: true, onChange: (ev) => setRenaming({ ...renaming, title: ev.target.value }), onKeyDown: (ev) => { if (ev.key === 'Enter') void saveRename(); } }),
              e('div', { className: 'ops' },
                e('button', { className: 'arc-btn', onClick: () => setRenaming(null) }, '取消'),
                e('button', { className: 'arc-btn primary', onClick: () => void saveRename() }, '保存')))) : null,
        );
      }

      // ================= 目录浏览弹窗（browse 能力， 手机端修复）=================
      function BrowseModal({ rpc, showToast, onPick, onClose }) {
        const [path, setPath] = useState('');
        const [crumbs, setCrumbs] = useState([]);
        const [entries, setEntries] = useState([]);
        const [loading, setLoading] = useState(false);
        const [creating, setCreating] = useState(false);
        const load = async (p) => {
          setLoading(true);
          try {
            const r = await rpc('directory.browse', p ? { path: p } : {});
            if (r && r.ok && r.value) {
              setPath(String(r.value.path ?? ''));
              setCrumbs(Array.isArray(r.value.crumbs) ? r.value.crumbs : []);
              setEntries(Array.isArray(r.value.entries) ? r.value.entries : []);
            } else {
              showToast(`目录读取失败：${(r && r.error) || '未知错误'}`);
            }
          } catch (error) {
            showToast(`目录读取失败：${String(error?.message || error)}`);
          } finally {
            setLoading(false);
          }
        };
        useEffect(() => { void load(); }, []);
        const createDir = async () => {
          let name = '';
          try { name = window.prompt('新建目录名称（在当前目录下创建）：', ''); } catch { /* ignore */ }
          if (!name || !String(name).trim()) return;
          setCreating(true);
          try {
            const r = await rpc('directory.browseCreate', { path, name: String(name).trim() });
            if (r && r.ok && r.value?.path) await load(r.value.path);
            else showToast(`新建目录失败：${(r && r.error) || '未知错误'}`);
          } catch (error) {
            showToast(`新建目录失败：${String(error?.message || error)}`);
          } finally {
            setCreating(false);
          }
        };
        return e('div', { className: 'arc-confirm' },
          e('div', { className: 'box arc-browse' },
            e('div', { className: 'msg' }, '浏览目录 · 选择新工作区'),
            e('div', { className: 'arc-browse-crumbs' },
              crumbs.length ? crumbs.map((c, i) => e('button', { key: `c${i}`, className: 'arc-btn small', onClick: () => void load(c.path) }, c.name)) : e('span', { className: 'arc-hint' }, '…')),
            e('div', { className: 'arc-browse-path' }, path || '…'),
            e('div', { className: 'arc-browse-list' },
              loading ? e('div', { className: 'arc-note' }, '读取中…') :
                entries.length === 0 ? e('div', { className: 'arc-note' }, '（空目录）') :
                  entries.map((en) => e('button', { key: en.path, className: `arc-btn arc-browse-item${en.hidden ? ' hidden' : ''}`, title: en.path, onClick: () => void load(en.path) }, `${en.name}/`))),
            e('div', { className: 'ops' },
              e('button', { className: 'arc-btn', disabled: creating, onClick: () => void createDir() }, '新建目录'),
              e('button', { className: 'arc-btn', onClick: onClose }, '取消'),
              e('button', { className: 'arc-btn primary', onClick: () => { onPick(path); onClose(); } }, '选择此目录')),
          ),
        );
      }

      // ================= 总控 =================
      function PageOverview({ rpc, showToast, gotoFeature, askConfirm }) {
        const [data, setData] = useState(null);
        const [busy, setBusy] = useState(false);
        const [backups, setBackups] = useState(null);
        const [backingUp, setBackingUp] = useState(false);
        const [token, setToken] = useState(null);
        const [metrics, setMetrics] = useState(null);
        const [autostart, setAutostart] = useState(null);
        const [dnd, setDnd] = useState(false);
        const [consistency, setConsistency] = useState(null);
        const [importing, setImporting] = useState('');
        // 一键更新（方案 D）
        const [upd, setUpd] = useState(null);
        const [checkingUpd, setCheckingUpd] = useState(false);
        const [applyingUpd, setApplyingUpd] = useState(false);
        const load = useCallback(async () => {
          setBusy(true);
          //  性能优化：updater.check 含 git 网络操作（fetch/ls-remote，实测 4.7s、差网超时 75s），
          // 从 Promise.all 拆出异步补更——"总控"页骨架不被网络操作拖住。
          //  阶段1（手机端 15s+ 修复）：overview 是纯本地聚合（loop/memory/evolution/schedule/notify
          // 内存快照，毫秒级）→ 先行 await 并立即 setData，页面骨架/概览即刻可见；其余 6 个 RPC
          // （backup.list 目录遍历、system.tokenUsage 自调 /api/session.list 等曾可拖数秒）改为逐项
          // 后台并行补更，各自就绪即刷新对应卡片——最慢项不再决定"总控加载中…"的时长。
          const r = await rpc('overview');
          setData(r.ok ? r.value : null);
          if (!r.ok) showToast(`总控加载失败：${r.error}`);
          setBusy(false); // overview 已就绪 → 首屏已渲染，按钮恢复；其余卡片后台补更
          const fill = async (promise, apply) => {
            try {
              const res = await promise;
              if (res && res.ok) apply(res.value);
            } catch { /* 单项失败不阻断其余补更 */ }
          };
          await Promise.all([
            fill(rpc('backup.list'), (v) => setBackups(v)),
            fill(rpc('system.tokenUsage'), (v) => setToken(v)),
            fill(rpc('system.metrics'), (v) => setMetrics(v)),
            fill(rpc('system.autostart'), (v) => setAutostart(v)),
            fill(rpc('system.dnd'), (v) => { if (v && typeof v.enabled === 'boolean') setDnd(v.enabled); }),
            fill(rpc('consistency.state'), (v) => setConsistency(v)),
          ]);
          const u = await rpc('updater.check');
          if (u.ok) setUpd(u.value);
          // 更新检查失败/离线不打扰：卡片保持"检查中…"，可点「检查更新」按钮实时重试
        }, [rpc, showToast]);
        useEffect(() => { void load(); }, [load]);
        const doBackup = async () => {
          setBackingUp(true);
          showToast('正在备份（含会话/记忆/设置/凭据）…');
          const r = await rpc('system.backup', { kind: 'manual' });
          setBackingUp(false);
          if (r.ok) { showToast(`备份完成（${r.value?.files ?? 0} 个文件）`); await load(); }
          else showToast(`备份失败：${r.error}`);
        };
        const doRestore = (name) => {
          setImporting(name);
          askConfirm(`恢复到备份「${name}」？\n整个项目将变为该备份记录的状态（记忆/会话/人格/任务/设置全部覆盖）。\n当前状态会先自动备份（可回退）；点击确认后请再点右上角「关闭」按钮重启，重启即完成恢复。`, async () => {
            const r = await rpc('system.restore', { backupDir: name });
            setImporting('');
            if (r.ok) showToast('恢复已暂存，请点「关闭」按钮重启完成恢复');
            else showToast(`恢复失败：${r.error}`);
          });
        };
        const toggleAutostart = async () => {
          const next = autostart?.enabled === true;
          const r = await rpc('system.autostart', { enabled: !next });
          if (r.ok) { setAutostart(r.value); showToast(next ? '已关闭开机自启' : '已开启开机自启（登录后自动运行）'); }
          else showToast(`操作失败：${r.error}`);
        };
        // 降频模式：用户自行决定是否把自循环兜底降到 30 分钟；不再自动依赖用户状态
        const toggleReduced = async () => {
          const cur = data?.loop?.stats?.config?.reducedMode === true;
          const r = await rpc('loop.configure', { reducedMode: !cur });
          if (r.ok) { showToast(!cur ? '降频模式已开启（兜底 30 分钟）' : '降频模式已关闭（兜底恢复默认）'); await load(); }
          else showToast(`操作失败：${r.error}`);
        };
        // 双 Agent：记忆加工（agent1 概括 recent/语义）+ 输出前审查（agent2 决策后）
        const toggleDual = async () => {
          const cur = data?.loop?.stats?.config?.dualAgent === true;
          const r = await rpc('loop.configure', { dualAgent: !cur });
          if (r.ok) { showToast(!cur ? '双 Agent 已开启（记忆概括+输出审查；略增耗时不影响关闭路径）' : '双 Agent 已关闭（恢复原单决策流程）'); await load(); }
          else showToast(`操作失败：${r.error}`);
        };
        const toggleDnd = async () => {
          const next = !dnd;
          const r = await rpc('system.dnd', { enabled: next });
          if (r.ok) { setDnd(next); showToast(next ? '勿扰模式已开启（通知仍弹窗，仅不响提示音）' : '勿扰模式已关闭'); }
          else showToast(`操作失败：${r.error}`);
        };
        // 人格一致性总控开关：settings/持久化状态经 consistency.configure 即时生效
        const toggleConsistency = async () => {
          const next = !(consistency?.enabled === true);
          const r = await rpc('consistency.configure', { enabled: next });
          if (r.ok) { setConsistency(r.value); showToast(next ? '人格一致性已开启' : '人格一致性已关闭'); }
          else showToast(`操作失败：${r.error}`);
        };
        // 一键更新（方案 D）；force=true 绕过服务端 60s 缓存实时复查
        const doCheckUpdate = async () => {
          setCheckingUpd(true);
          const r = await rpc('updater.check', { force: true });
          setCheckingUpd(false);
          if (r.ok) {
            setUpd(r.value);
            if (r.value.offline) showToast('检查失败：' + (r.value.note || '网络或未配置更新地址（git fetch 不可达）'));
            else if (r.value.hasUpdate) showToast(`发现新版本${r.value.remoteVersion ? ' ' + r.value.remoteVersion : ''}，可一键更新`);
            else if (r.value.ahead > 0) showToast('本地领先远程（可能是开发机），请先推送或忽略');
            else showToast('已是最新版本');
          } else showToast(`检查失败：${r.error}`);
        };
        const doApplyUpdate = () => {
          askConfirm('确定立即更新？\n将停止服务 → 拉取更新 → 重新启动。期间页面会短暂断开，稍后请刷新页面（或等浏览器自动打开新页面）。更新只动代码，dsh\\data、ollama、backups 不受影响。', async () => {
            setApplyingUpd(true);
            const r = await rpc('updater.apply');
            if (r.ok) showToast('更新已启动，服务将重启，请稍候刷新页面');
            else { setApplyingUpd(false); showToast(`启动更新失败：${r.error}`); }
          });
        };
        const fmtNum = (x) => (x == null ? '—' : (Math.round(Number(x) * 100) / 100).toString());
        if (!data) return e(Empty, { icon: '🎛️', text: '总控加载中…' });
        const l = data.loop ?? {};
        const m = data.memory ?? {};
        const ev = data.evolution ?? {};
        const sch = data.schedule ?? {};
        const ntf = data.notify ?? {};
        const byStatus = sch.byStatus ?? {};
        const backupList = Array.isArray(backups?.backups) ? backups.backups : [];
        const tk = token?.session ?? {};
        const fmtBytes = (b) => (b > 0 ? `${(b / 1024 / 1024).toFixed(1)} MB` : '');
        return e('div', null,
          e(Card, { title: '🎛️ 智能体总控', right: e(Btn, { label: busy ? '刷新中…' : '↻ 刷新全部', onClick: () => void load(), small: true }) },
            e('p', { className: 'dim' }, '人格 / 思维循环 / 记忆 / 自进化 / 定时任务 / 通知 —— 各功能页在左侧；以下为实时运行概览。')),
          e(Stats, { items: [
            { k: '虚拟时钟', v: data.clock?.now ?? '—' },
            { k: '循环状态', v: l.stats?.mode ?? '—' },
            { k: '循环次数', v: l.stats?.cycleCount ?? 0 },
            { k: '记忆(活跃)', v: m.active ?? 0 },
            { k: '记忆(软遗忘)', v: m.soft ?? 0 },
            { k: '记忆(归档)', v: m.archived ?? 0 },
            { k: '记忆(受保护)', v: m.protected ?? 0 },
            { k: '进化候选', v: ev.totalCandidates ?? 0 },
            { k: '任务(待办)', v: byStatus.pending ?? 0 },
            { k: '通知未读', v: ntf.unread ?? 0 },
          ] }),
          e(Card, { title: '💾 一键备份', right: e(Btn, { label: backingUp ? '备份中…' : '开始备份', kind: 'primary', small: true, onClick: () => void doBackup(), disabled: backingUp }) },
            e('p', { className: 'dim' }, '手动备份到项目文件夹 backups\\；系统每 3 天自动备份一次（自动保留最近 10 份）。换机时把 backups 拷过来，用「恢复」把整个项目还原到备份状态（需重启生效；当前状态会先自动备份）。'),
            backupList.length > 0
              ? e('div', { className: 'arc-list', style: { marginTop: 8 } },
                  backupList.slice(0, 6).map((b) => e('div', { key: b.name, className: 'arc-item' },
                    e('div', { className: 't2' },
                      e(Badge, { text: b.kind === 'auto' ? '自动' : '手动', tone: b.kind === 'auto' ? 'dim' : 'brand' }),
                      e('span', null, b.name),
                      e('span', null, fmtFull(b.at)),
                      e('span', null, fmtBytes(b.bytes)),
                      e(Btn, { label: '恢复', small: true, disabled: importing === b.name, onClick: () => doRestore(b.name) })))))
              : e('p', { className: 'arc-hint', style: { marginTop: 8 } }, '暂无备份。'),
            e('p', { className: 'arc-hint', style: { marginTop: 6 } }, `备份目录：${backups?.root ?? 'C:/DSH-ARCHIVE/backups'}`)),
          e(Card, { title: '🔄 检查更新', right: e(Btn, { label: checkingUpd ? '检查中…' : '检查更新', small: true, onClick: () => void doCheckUpdate(), disabled: checkingUpd || applyingUpd }) },
            upd
              ? (upd.offline
                  ? e('p', { className: 'dim' }, upd.note || `当前版本 ${upd.currentVersion || '?'}；检查失败（网络或未配置更新地址）。`)
                  : upd.hasUpdate
                    ? e('div', null,
                        e('p', { className: 'dim' }, `发现新版本 ${upd.remoteVersion || upd.remoteCommit?.slice(0, 7) || '?'}（当前 ${upd.currentVersion || '?'}）。`),
                        e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
                          e(Btn, { label: applyingUpd ? '更新已启动…' : '立即更新', kind: 'primary', onClick: () => doApplyUpdate(), disabled: applyingUpd }),
                          e(Badge, { text: `落后 ${upd.behind ?? 0} 个提交`, tone: 'warn' })))
                    : upd.ahead > 0
                      ? e('p', { className: 'dim' }, `本地领先远程 ${upd.ahead} 个提交（可能是开发机忘了推送）。当前版本 ${upd.currentVersion || '?'}。`)
                      : e('p', { className: 'dim' }, `已是最新版本（${upd.currentVersion || '?'}）。`))
              : e('p', { className: 'dim' }, '检查中…'),
            e('p', { className: 'arc-hint', style: { marginTop: 6 } }, '检查 GitHub 远程仓库是否有新版本；更新只动代码，dsh\\data、ollama、backups 不受影响；更新会重启服务。')),
          e(Card, { title: '🔢 Token 用量' },
            e('div', { className: 'arc-stats', style: { marginBottom: 0 } },
              e('div', { className: 'arc-stat' }, e('div', { className: 'v' }, Math.round((tk.outputTokens ?? 0)).toLocaleString()), e('div', { className: 'k' }, '输出 tokens')),
              e('div', { className: 'arc-stat' }, e('div', { className: 'v' }, Math.round((tk.uncachedInputTokens ?? 0)).toLocaleString()), e('div', { className: 'k' }, '输入 tokens')),
              e('div', { className: 'arc-stat' }, e('div', { className: 'v' }, Math.round((tk.cacheReadTokens ?? 0)).toLocaleString()), e('div', { className: 'k' }, '缓存读取')),
              e('div', { className: 'arc-stat' }, e('div', { className: 'v' }, (token?.loop?.cycleCount ?? 0)), e('div', { className: 'k' }, '自循环次数'))),
            e('p', { className: 'arc-hint', style: { marginTop: 6 } }, '会话为精确 token；自循环按调用次数展示。')),
          e(Card, { title: '📈 系统监控' },
            e('div', { className: 'arc-stats', style: { marginBottom: 0 } },
              e('div', { className: 'arc-stat' }, e('div', { className: 'v' }, metrics?.uptime ? `${Math.floor(metrics.uptime / 3600)}h${Math.floor((metrics.uptime % 3600) / 60)}m` : '—'), e('div', { className: 'k' }, '运行时长')),
              e('div', { className: 'arc-stat' }, e('div', { className: 'v' }, metrics?.rss ? `${(metrics.rss / 1024 / 1024).toFixed(0)} MB` : '—'), e('div', { className: 'k' }, '内存 RSS')),
              e('div', { className: 'arc-stat' }, e('div', { className: 'v' }, metrics?.loop?.cycleCount ?? '—'), e('div', { className: 'k' }, '循环总数')),
              e('div', { className: 'arc-stat' }, e('div', { className: 'v' }, metrics?.loop?.errorCount ?? '—'), e('div', { className: 'k' }, '循环失败'))),
            Array.isArray(metrics?.history) && metrics.history.length > 0
              ? e('div', { className: 'arc-list', style: { marginTop: 8 } },
                  metrics.history.slice(-8).map((h) => e('div', { key: h.t, className: 'arc-item' },
                    e('div', { className: 't2' },
                      e('span', null, fmtTime(h.t)),
                      e('span', null, `RSS ${(h.rss / 1024 / 1024).toFixed(0)}MB`),
                      e('span', null, `循环 ${h.cycle ?? 0}`),
                      e('span', null, `失败 ${h.errors ?? 0}`)))))
              : null),
          e(Card, { title: '⚙️ 开机自启', right: e(Btn, { label: autostart?.enabled ? '关闭自启' : '开启自启', kind: autostart?.enabled ? 'danger' : 'primary', small: true, onClick: () => void toggleAutostart() }) },
            e('p', { className: 'dim' }, autostart?.enabled ? '已开启：登录 Windows 后自动启动 DSH-ARCHIVE（隐藏窗口）。' : '未开启：开机后需手动双击「启动DSH-ARCHIVE.cmd」。'),
            e('p', { className: 'arc-hint' }, '开关随时可切换；自启为登录启动（start.ps1 -NoOpen，不自动打开浏览器）。')),
          e(Card, { title: '🎚️ 运行模式', right: e('div', { style: { display: 'flex', gap: 6 } },
            e(Btn, { label: dnd ? '关闭勿扰' : '开启勿扰', kind: dnd ? 'danger' : 'primary', small: true, onClick: () => void toggleDnd() }),
            e(Btn, { label: (data?.loop?.stats?.config?.dualAgent === true) ? '关闭双Agent' : '开启双Agent', kind: (data?.loop?.stats?.config?.dualAgent === true) ? 'danger' : 'primary', small: true, onClick: () => void toggleDual(), title: '双 Agent：记忆加工(agent1 概括 recent/语义)+输出前审查(agent2 决策后)；默认关=与旧流程完全一致' }),
            e(Btn, { label: (data?.loop?.stats?.config?.reducedMode === true) ? '关闭降频' : '开启降频', kind: (data?.loop?.stats?.config?.reducedMode === true) ? 'danger' : 'primary', small: true, onClick: () => void toggleReduced() })) },
            e('div', { className: 't2', style: { gap: 8, flexWrap: 'wrap' } },
              e(Badge, { text: dnd ? '勿扰：不响提示音' : '提示音开', tone: dnd ? 'dim' : 'good' }),
              e(Badge, { text: (data?.loop?.stats?.config?.dualAgent === true) ? '🧠 双Agent：记忆加工+输出审查' : '单Agent 决策', tone: (data?.loop?.stats?.config?.dualAgent === true) ? 'warn' : 'good' }),
              e(Badge, { text: (data?.loop?.stats?.config?.reducedMode === true) ? '降频：兜底 30 分钟' : `兜底 ${Math.round((data?.loop?.stats?.config?.effectiveFallbackMs ?? 300000) / 60000)} 分钟`, tone: (data?.loop?.stats?.config?.reducedMode === true) ? 'warn' : 'good' }),
              e(Badge, { text: sleepLabelOf(data?.loop?.sleep), tone: data?.loop?.sleep?.phase === 'asleep' ? 'dim' : data?.loop?.sleep?.phase === 'cooldown' ? 'warn' : 'good' })),
            e('p', { className: 'arc-hint', style: { marginTop: 6 } }, '勿扰：通知仍弹窗/进列表，仅不播放提示音。双 Agent：开启后每轮先由记忆分析师把召回记忆按 recent/语义概括（recent 含当前情况与用户隐含情绪），决策 agent 读概括而非原文，输出前再过审查（通顺/行动合理/不重复/符合人设，可更正或取消）——减少注意力分散与重复/推翻；关闭则流程与原先完全一致。降频：自循环无事件时兜底思考从默认间隔降为 30 分钟（由你决定，不自动按睡眠判断）。睡眠期：用户睡眠中持续 ≥30 分钟且未来 8 小时无定时任务 → 循环完全暂停（定时任务照常触发并打断）；仅真实唤醒信号解除，状态 TTL 到期保持静默，解除后进 3 小时强制清醒间隔。详情见「思维循环」页。')),
          e(Card, { title: '🛡️ 人格一致性', right: e(Btn, { label: consistency?.enabled ? '关闭' : '开启', kind: consistency?.enabled ? 'danger' : 'primary', small: true, onClick: () => void toggleConsistency() }) },
            e('p', { className: 'dim' }, consistency?.enabled
              ? `已开启：对比人格发展轨迹，防止 AI 角色偏离过大。已检测 ${consistency?.stats?.checks ?? 0} 次（放行 ${consistency?.stats?.pass ?? 0} / 可疑 ${consistency?.stats?.suspicious ?? 0} / 拦截 ${consistency?.stats?.blocked ?? 0}），轨迹点 ${consistency?.turnCount ?? 0}，航点 ${consistency?.waypointCount ?? 0}，阈值 α ${fmtNum(consistency?.alpha)} / β ${fmtNum(consistency?.beta)}。`
              : '已关闭：人格一致性校验不运行（不影响记忆/人格其他能力）。'),
            e('p', { className: 'arc-hint', style: { marginTop: 6 } }, '开关即时生效并持久化；阈值调整、轨迹坐标图与拦截/修订/倒叙修正记录见「一致性」页。')),
          e(Card, { title: '⚡ 快速入口' },
            e('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              FEATURES.filter(([id]) => id !== 'overview').map(([id, label, icon]) =>
                e(Btn, { key: id, label: `${icon} ${label}`, onClick: () => gotoFeature(id) })))),
        );
      }

      // ================= 人格 =================
      function PagePersona({ rpc, showToast, askConfirm }) {
        const [data, setData] = useState(null); // persona.get()
        const [stats, setStats] = useState(null);
        const [history, setHistory] = useState(null);
        const [busy, setBusy] = useState(false);
        const [editing, setEditing] = useState(null); // {id, content, importance}
        const [newSection, setNewSection] = useState('traits');
        const [newContent, setNewContent] = useState('');
        const [newImportance, setNewImportance] = useState('0.5');
        //  一键凝练（LLM 无损整理）：distilling=生成中；distill=预览结果；applying=写入中
        const [distilling, setDistilling] = useState(false);
        const [distill, setDistill] = useState(null);
        const [distillErr, setDistillErr] = useState('');
        const [applying, setApplying] = useState(false);

        const load = useCallback(async () => {
          setBusy(true);
          const [g, s, h] = await Promise.all([rpc('persona.get'), rpc('persona.stats'), rpc('persona.history', { limit: 30 })]);
          if (g.ok) setData(g.value); else showToast(`人格加载失败：${g.error}`);
          if (s.ok) setStats(s.value);
          if (h.ok) setHistory(h.value?.records ?? h.value ?? null);
          setBusy(false);
        }, [rpc, showToast]);
        useEffect(() => { void load(); }, [load]);

        const saveEdit = async (id) => {
          if (!editing) return;
          const r = await rpc('persona.update', { id, content: editing.content, importance: Number(editing.importance) });
          if (r.ok) { showToast('已保存'); setEditing(null); void load(); } else showToast(`保存失败：${r.error}`);
        };
        const removeEntry = async (id, content) => {
          askConfirm(`删除该人格条目？\n${truncate(content, 60)}`, async () => {
            const r = await rpc('persona.remove', { id });
            if (r.ok) { showToast('已删除'); void load(); } else showToast(`删除失败：${r.error}`);
          });
        };
        const addEntry = async () => {
          const content = newContent.trim();
          if (!content) { showToast('请输入条目内容'); return; }
          const r = await rpc('persona.set', { entries: [{ section: newSection, content, importance: Number(newImportance) }], summary: 'webui 新增' });
          if (r.ok) { showToast(`已新增（v${r.value?.version}）`); setNewContent(''); void load(); } else showToast(`新增失败：${r.error}`);
        };
        const doRollback = async (version, by) => {
          askConfirm(`回滚到人格版本 ${version}？（当前内容将被该版本快照替换，留档可追溯）`, async () => {
            const r = await rpc('persona.rollback', { version, by: 'user' });
            if (r.ok) { showToast(r.value?.rolledBack ? '已回滚' : '回滚失败：版本不存在'); void load(); } else showToast(`回滚失败：${r.error}`);
          });
        };

        const sections = data?.sections ?? {};
        // =====  一键凝练（LLM 无损整理全量人格条目） =====
        const sectionLabel = (sid) => (PERSONA_SECTIONS.find(([x]) => x === sid) ?? [sid, sid])[1];
        // 原条目 id → {section, content}（预览里展示"本条合并了哪些原文"）
        const distillOrigin = {};
        for (const list of Object.values(sections)) {
          if (!Array.isArray(list)) continue;
          for (const en of list) if (en?.id) distillOrigin[en.id] = en;
        }
        const runDistill = () => {
          if (distilling || applying) return;
          const total = stats?.total ?? Object.values(sections).reduce((a, l) => a + (Array.isArray(l) ? l.length : 0), 0);
          if (total <= 0) { showToast('当前无人格条目，无需凝练'); return; }
          askConfirm(`将调用 LLM 凝练当前全部 ${total} 条人格条目：\n· 按项目六分区（身份/价值观/性格/表达风格/行为准则/能力清单）重新归类；\n· 合并相同/相似条目，无损保留全部信息与要求；\n· 严格按 YAML 重新编写；先在此预览，确认后才写入。\n\n生成通常需 30 秒~2 分钟（期间请勿关闭页面）。`, async () => {
            setDistilling(true); setDistillErr(''); setDistill(null);
            try {
              const r = await rpc('persona.distillPreview');
              if (r.ok) setDistill(r.value);
              else { setDistillErr(String(r.error ?? '凝练失败')); showToast(`凝练失败：${r.error}`); }
            } catch (err) { setDistillErr(String(err?.message ?? err)); showToast('凝练请求异常，请重试'); }
            setDistilling(false);
          });
        };
        const applyDistill = () => {
          if (!distill || applying) return;
          askConfirm('确认应用这版凝练结果？\n将以新版本整体替换当前人格（旧版本已留档，可随时在下文「留档历史与回滚」恢复）。', async () => {
            setApplying(true); setDistillErr('');
            try {
              const r = await rpc('persona.distillApply', { token: distill.token });
              if (r.ok) { showToast(`✅ 凝练已应用（新版本 v${r.value?.version}，${r.value?.added} 条）`); setDistill(null); void load(); }
              else { setDistillErr(String(r.error ?? '应用失败')); showToast(`应用失败：${r.error}`); }
            } catch (err) { setDistillErr(String(err?.message ?? err)); showToast('应用请求异常，请重试'); }
            setApplying(false);
          });
        };
        const renderDistillPreview = () => {
          if (!distill) return null;
          const beforeSec = distill.before?.bySection ?? {};
          const afterSec = distill.after?.bySection ?? {};
          const changed = [];
          for (const [sid] of PERSONA_SECTIONS) {
            const b = beforeSec[sid] ?? 0; const a = afterSec[sid] ?? 0;
            if (b > 0 || a > 0) changed.push(`${sectionLabel(sid)} ${b}→${a}`);
          }
          const groups = PERSONA_SECTIONS
            .map(([sid, slabel]) => ({ sid, slabel, items: (distill.entries ?? []).filter((en) => en.section === sid) }))
            .filter((g) => g.items.length > 0);
          return e('div', { style: { marginTop: 6 } },
            distill.direction ? e('p', { className: 'arc-note', style: { color: 'var(--arc-dim)', fontStyle: 'italic', marginBottom: 6 } }, `💡 整理思路：${distill.direction}`) : null,
            e('div', { className: 't2', style: { marginBottom: 8 } },
              e('span', { style: { fontWeight: 600, color: 'var(--arc-good)' } }, `共 ${distill.before?.total ?? 0} 条 → ${distill.after?.total ?? 0} 条`),
              changed.length > 0 ? e('span', null, `（${changed.join('；')}）`) : null),
            groups.map((g) => e('div', { key: g.sid, style: { marginBottom: 12 } },
              e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 4px' } },
                e('span', { style: { fontWeight: 600, fontSize: 13 } }, g.slabel),
                e('span', { className: 'arc-tag' }, g.sid),
                e('span', { className: 'arc-hint' }, `${g.items.length} 条`)),
              e('div', { className: 'arc-list' },
                g.items.map((en, i) => e('div', { key: `${g.sid}-${i}`, className: 'arc-item' },
                  e('div', { className: 't1' }, en.content),
                  e('div', { className: 't2' },
                    e('span', null, `重要度 ${pct(en.importance ?? 0.5)}`),
                    e('span', { style: { color: 'var(--arc-brand)' } }, `合并 ${(en.mergedFrom ?? []).length} 条原文`)),
                  e('div', { style: { marginTop: 4, fontSize: 12, color: 'var(--arc-faint)' } },
                    (en.mergedFrom ?? []).map((id) => {
                      const o = distillOrigin[id];
                      return e('div', { key: id, style: { marginTop: 2 } }, o
                        ? `↳ [${sectionLabel(o.section)}] ${truncate(o.content, 70)}`
                        : `↳ [原条目 ${id}]`);
                    }))))))),
            e('div', { style: { display: 'flex', gap: 8, marginTop: 4 } },
              e(Btn, { label: applying ? '应用中…' : '✅ 应用凝练结果', kind: 'primary', onClick: () => void applyDistill() }),
              e(Btn, { label: '放弃预览', small: true, onClick: () => { setDistill(null); setDistillErr(''); } })),
          );
        };
        return e('div', null,
          e(Stats, { items: [
            { k: '版本', v: stats?.version ?? data?.version ?? '—' },
            { k: '条目总数', v: stats?.total ?? 0 },
            { k: '最后修改', v: stats?.lastModifiedBy ?? '—' },
            { k: '更新时间', v: fmtTime(stats?.updatedAt) },
          ] }),
          e(Card, { title: '✨ 一键凝练（LLM 无损整理）', right: e(Btn, { label: distilling ? '凝练中…' : '开始凝练', kind: 'primary', small: true, onClick: () => void runDistill() }) },
            distillErr ? e('p', { className: 'arc-note', style: { color: 'var(--arc-err)', margin: '0 0 8px' } }, distillErr) : null,
            distilling
              ? e('p', { className: 'dim' }, '⏳ 正在调用 LLM 凝练全部人格条目：合并相同/相似条目、按项目六分区归类、无损保留全部信息与要求，严格按 YAML 重写。预计 30 秒~2 分钟，请勿关闭页面…')
              : (distill ? renderDistillPreview() : e('div', { className: 'arc-hint' }, '把全部人格条目交给 LLM 做一次无损整理：合并相同/相似条目、按项目六分区（身份/价值观/性格/表达风格/行为准则/能力清单）归类、严格 YAML 重写，不丢失任何信息与要求。结果先在此预览，确认后才写入新版本（旧版留档、可随时回滚）。')),
          ),
          e(Card, { title: '➕ 新增人格条目', right: e(Btn, { label: '添加', kind: 'primary', onClick: () => void addEntry(), small: true }) },
            e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              e('select', { className: 'arc-sel', style: { width: 150, margin: 0 }, value: newSection, onChange: (ev) => setNewSection(ev.target.value) },
                PERSONA_SECTIONS.map(([id, label]) => e('option', { key: id, value: id }, label))),
              e('input', { className: 'arc-text', style: { flex: 1, margin: 0, minWidth: 220 }, placeholder: '条目内容（自包含陈述）', value: newContent, onChange: (ev) => setNewContent(ev.target.value) }),
              e('input', { className: 'arc-text', style: { width: 70, margin: 0 }, placeholder: '重要度', value: newImportance, onChange: (ev) => setNewImportance(ev.target.value) }),
            ),
            e('div', { className: 'arc-hint' }, '重要度 0~1（≥0.8 自动受遗忘保护）；新增将提升版本并留档。'),
          ),
          e(Card, { title: '📖 人格条目', right: e(Btn, { label: busy ? '刷新中…' : '↻ 刷新', onClick: () => void load(), small: true }) },
            PERSONA_SECTIONS.map(([sid, slabel]) => {
              const entries = sections[sid] ?? [];
              if (entries.length === 0) return null;
              return e('div', { key: sid, style: { marginBottom: 14 } },
                e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0 6px' } },
                  e('span', { style: { fontWeight: 600, fontSize: 13 } }, slabel),
                  e('span', { className: 'arc-tag' }, sid),
                  e('span', { className: 'arc-hint' }, `${entries.length} 条`)),
                e('div', { className: 'arc-list' },
                  entries.map((en) => e('div', { key: en.id, className: 'arc-item' },
                    editing && editing.id === en.id
                      ? e('div', null,
                          e('textarea', { className: 'arc-textarea', value: editing.content, onChange: (ev) => setEditing({ ...editing, content: ev.target.value }) }),
                          e('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                            e('input', { className: 'arc-text', style: { width: 90, margin: 0 }, title: '重要度 0~1', value: editing.importance, onChange: (ev) => setEditing({ ...editing, importance: ev.target.value }) }),
                            e(Btn, { label: '保存', kind: 'primary', small: true, onClick: () => void saveEdit(en.id) }),
                            e(Btn, { label: '取消', small: true, onClick: () => setEditing(null) })))
                      : e('div', null,
                          e('div', { className: 't1' }, en.content),
                          e('div', { className: 't2' },
                            e('span', null, `重要度 ${pct(en.importance)}`),
                            e('span', null, `置信 ${pct(en.confidence)}`),
                            en.addedBy ? e('span', null, `来源 ${en.addedBy}`) : null,
                            e('span', null, `添加 ${fmtTime(en.addedAt)}`),
                            en.modifiedBy ? e('span', null, `改于 ${fmtTime(en.modifiedAt)}`) : null,
                            en.source ? e('span', null, `(${en.source})`) : null),
                          e('div', { className: 'ops' },
                            e(Btn, { label: '编辑', small: true, onClick: () => setEditing({ id: en.id, content: en.content, importance: String(en.importance ?? 0.5) }) }),
                            e(Btn, { label: '删除', kind: 'danger', small: true, onClick: () => void removeEntry(en.id, en.content) })))))),
              );
            }),
            e('div', { className: 'arc-hint', style: { marginTop: 4 } }, '空分区不显示。条目由「人格」注入每回合对话，修改会留档。'),
          ),
          e(Card, { title: '🕘 留档历史与回滚' },
            Array.isArray(history) && history.length > 0
              ? e('div', { className: 'arc-list' },
                  history.map((h) => e('div', { key: `${h.version}-${h.at}`, className: 'arc-item' },
                    e('div', { className: 't2' },
                      e('span', { style: { fontWeight: 600, color: 'var(--arc-tx)' } }, `v${h.version}`),
                      e('span', null, fmtFull(h.at)),
                      e('span', null, `by ${h.by}`)),
                    e('div', { className: 't1', style: { marginTop: 4 } }, h.summary ?? ''),
                    h.version !== (stats?.version ?? data?.version)
                      ? e('div', { className: 'ops' }, e(Btn, { label: '回滚到此版本', small: true, onClick: () => void doRollback(h.version, h.by) }))
                      : null)))
              : e('p', { className: 'dim' }, '暂无留档记录。')),
        );
      }

      // ================= 思维循环 =================
      //：前置思考参数编辑范围（与 modules/loop/lib/index.js 的 PRE_TURN_* 常量保持一致；
      // 上限防"乱填超大值"：JS setTimeout 超 2^31-1ms 会溢出成 ~1ms 立即触发、每个回合的 pre-turn 全被砍）
      const PRE_CAP_MIN = 5000;
      const PRE_CAP_MAX = 600000;
      const PRE_TOK_MIN = 500;
      const PRE_TOK_MAX = 60000;
      // ================= 思维预设 =================
      //：用户指令注入（决策/审查/对话自检），适配双 Agent。
      // 名称刻意自拟，不借用其他产品的功能名。零配置=零注入零变化。
      function InstrPanel({ rpc, showToast, askConfirm }) {
        const [data, setData] = useState(null); // {presets, activePresetId, entries, injectCapChars}
        const [busy, setBusy] = useState(false);
        const [err, setErr] = useState('');
        const [capStr, setCapStr] = useState('1200');
        const [capDirty, setCapDirty] = useState(false); // 上限输入框是否有未保存改动（防 effect 复位用户输入）
        const [newPreset, setNewPreset] = useState('');
        const [renaming, setRenaming] = useState(null); // {id, name}
        const [edit, setEdit] = useState(null); // 正在编辑的指令副本；null=无
        const [previewText, setPreviewText] = useState('');
        const [preview, setPreview] = useState(null);
        const [pvBusy, setPvBusy] = useState(false);
        const MODE_LABEL = { always: '常驻', keys: '关键词触发' };
        const SCOPE_LABEL = { loop: '思维循环', both: '循环+对话', dialogue: '仅对话' };

        const load = useCallback(async () => {
          const r = await rpc('loop.instructions.get');
          if (r.ok) { setData(r.value); setErr(''); } else setErr(`读取失败：${r.error || ''}`);
        }, [rpc]);
        useEffect(() => { void load(); }, [load]);

        const save = async (next, okMsg) => {
          setBusy(true); setErr('');
          const r = await rpc('loop.instructions.save', { state: next });
          setBusy(false);
          if (r.ok) { setData(r.value); if (okMsg) showToast(okMsg); return true; }
          const m = `保存失败：${r.error || ''}`; setErr(m); showToast(m); return false;
        };
        /** 同组内按数组顺序重建 order（数组顺序即展示顺序）。 */
        const regroup = (entries) => {
          const seen = new Map();
          return entries.map((en) => {
            const idx = seen.get(en.presetId) ?? 0;
            seen.set(en.presetId, idx + 1);
            return { ...en, order: idx };
          });
        };
        const presetName = (id) => (data?.presets ?? []).find((p) => p.id === id)?.name ?? '';

        const addPreset = async () => {
          const name = newPreset.trim().slice(0, 40);
          if (!name) { showToast('请输入预设名称'); return; }
          if ((data.presets ?? []).length >= 20) { showToast('预设数量已达上限（20）'); return; }
          const p = { id: `p${Date.now().toString(36)}`, name };
          if (await save({ ...data, presets: [...data.presets, p] }, `已创建预设「${name}」`)) setNewPreset('');
        };
        const renamePreset = async () => {
          if (!renaming) return;
          const name = renaming.name.trim().slice(0, 40);
          if (!name) { showToast('预设名称不能为空'); return; }
          if (await save({ ...data, presets: data.presets.map((p) => (p.id === renaming.id ? { ...p, name } : p)) }, '已重命名')) setRenaming(null);
        };
        const delPreset = (p) => {
          askConfirm(`删除预设「${p.name}」？其下全部指令（${data.entries.filter((en) => en.presetId === p.id).length} 条）将一并删除。`, async () => {
            const next = {
              ...data,
              presets: data.presets.filter((x) => x.id !== p.id),
              entries: data.entries.filter((en) => en.presetId !== p.id),
              activePresetId: data.activePresetId === p.id ? '' : data.activePresetId,
            };
            await save(next, '已删除预设');
          });
        };
        const activate = async (id) => {
          if (id === data.activePresetId) return;
          await save({ ...data, activePresetId: id }, id ? `已启用「${presetName(id)}」（思维循环/双Agent生效）` : '已停用思维预设');
        };
        const saveCap = async () => {
          const n = Number(capStr);
          if (!Number.isFinite(n) || n < 200 || n > 8000) { showToast('注入上限需在 200 ~ 8000 字符之间'); return; }
          if (await save({ ...data, injectCapChars: Math.floor(n) }, `注入预算上限已设为 ${Math.floor(n)} 字符`)) setCapDirty(false);
        };

        const openNew = () => {
          const presetId = data.activePresetId || data.presets[0]?.id || '';
          if (!presetId) { showToast('请先创建并启用一个预设'); return; }
          setEdit({ id: `e${Date.now().toString(36)}`, presetId, name: '', mode: 'always', scope: 'loop', keys: [], keysText: '', text: '', enabled: true, isNew: true });
        };
        const openEdit = (en) => setEdit({ ...en, keysText: (en.keys ?? []).join('、'), isNew: false });
        const saveEntry = async () => {
          if (!edit) return;
          const name = (edit.name || '').trim().slice(0, 40);
          if (!name) { showToast('指令名称不能为空'); return; }
          const text = (edit.text || '').trim();
          if (!text) { showToast('指令内容不能为空'); return; }
          if (text.length > 1500) { showToast('指令内容不能超过 1500 字'); return; }
          let keys = (edit.keysText || '').split(/[、,，;\s]+/).map((k) => k.trim()).filter(Boolean);
          let mode = edit.mode === 'keys' ? 'keys' : 'always';
          let scope = edit.scope === 'both' || edit.scope === 'dialogue' ? edit.scope : 'loop';
          if (mode === 'keys') {
            if (keys.length === 0) { showToast('关键词触发指令至少需要一个关键词'); return; }
            keys = keys.slice(0, 10).map((k) => k.slice(0, 40));
            if (scope !== 'loop') scope = 'loop'; // 与宿主端一致：关键词触发仅作用于思维循环
          }
          const { isNew, keysText, ...rest } = edit;
          const entry = { ...rest, id: rest.id, name, text, mode, scope, keys, enabled: rest.enabled !== false };
          const list = isNew ? [...data.entries, entry] : data.entries.map((en) => (en.id === entry.id ? entry : en));
          if (await save({ ...data, entries: regroup(list) }, isNew ? '已添加指令' : '已保存指令')) setEdit(null);
        };
        const delEntry = (en) => {
          askConfirm(`删除指令「${en.name}」？`, async () => {
            await save({ ...data, entries: data.entries.filter((x) => x.id !== en.id) }, '已删除指令');
          });
        };
        const toggleEnabled = (en) => {
          const next = { ...en, enabled: !(en.enabled !== false) };
          void save({ ...data, entries: data.entries.map((x) => (x.id === en.id ? next : x)) }, next.enabled ? `已启用「${en.name}」` : `已停用「${en.name}」`);
        };
        const moveEntry = (en, dir) => {
          const list = [...data.entries];
          const i = list.findIndex((x) => x.id === en.id);
          let j = i + dir;
          while (j >= 0 && j < list.length && list[j].presetId !== en.presetId) j += dir; // 同预设内移动
          if (j < 0 || j >= list.length) return;
          [list[i], list[j]] = [list[j], list[i]];
          void save({ ...data, entries: regroup(list) });
        };
        const runPreview = async () => {
          if (!data.activePresetId) { showToast('请先启用一个预设再预览'); setPreview(null); return; }
          setPvBusy(true);
          const r = await rpc('loop.instructions.preview', { text: previewText, presetId: data.activePresetId });
          setPvBusy(false);
          if (r.ok) setPreview(r.value); else showToast(`预览失败：${r.error || ''}`);
        };

        // 服务端数值变化（加载/保存后）且输入框无未保存改动时回填；用户输入期间不复位
        useEffect(() => { if (data && !capDirty) setCapStr(String(data.injectCapChars ?? 1200)); }, [data?.injectCapChars, capDirty]); // eslint-disable-line react-hooks/exhaustive-deps

        if (!data) return e('p', { className: 'dim' }, '加载中…');
        const activeName = presetName(data.activePresetId);
        return e('div', null,
          e('p', { className: 'arc-hint', style: { marginBottom: 10 } },
            '思维预设 = 你插入的用户指令：常驻指令每轮生效；关键词指令在命中「你的消息/用户状态/近期用户消息」时生效；作用域含对话的常驻指令会附在对话回复自检后（双 Agent 开启时）。指令为最高优先级，决策与审查都会核对。零配置时与旧流程完全一致。'),
          // 预设管理
          e(Card, { title: '🗂️ 预设（同时只启用一个）', right: [e(Badge, { key: 'st', text: data.activePresetId ? `启用中：${activeName}` : '未启用', tone: data.activePresetId ? 'good' : 'dim' }), e(Btn, { key: 'rf', label: '↻ 刷新', small: true, title: '重新读取服务器配置', onClick: () => void load(), disabled: busy })] },
            (data.presets ?? []).map((p) => e('div', { key: p.id, style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' } },
              p.id === data.activePresetId
                ? [e(Badge, { key: 'on', text: `✓ 启用中：${p.name}`, tone: 'good' }),
                   e(Btn, { key: 'off', label: '停用', small: true, kind: 'danger', onClick: () => void activate(''), disabled: busy })]
                : [e(Btn, { key: 'on', label: `启用「${p.name}」`, small: true, kind: 'primary', onClick: () => void activate(p.id), disabled: busy })],
              e(Btn, { label: '改名', small: true, onClick: () => setRenaming(renaming?.id === p.id ? null : { id: p.id, name: p.name }) }),
              e(Btn, { label: '删除', small: true, kind: 'danger', onClick: () => delPreset(p) }),
              e('span', { className: 'dim', style: { fontSize: 12 } }, `${data.entries.filter((en) => en.presetId === p.id).length} 条`))),
            (data.presets ?? []).length === 0 && e('p', { className: 'dim' }, '尚无预设。新建一个并启用，再添加指令即可让思维循环遵守。'),
            renaming && e('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
              e('input', { className: 'arc-text', style: { flex: 1 }, value: renaming.name, maxLength: 40, onChange: (ev) => setRenaming({ ...renaming, name: ev.target.value }) }),
              e(Btn, { label: '确定', small: true, kind: 'primary', onClick: () => void renamePreset() }),
              e(Btn, { label: '取消', small: true, onClick: () => setRenaming(null) })),
            e('div', { style: { display: 'flex', gap: 6, marginTop: 8 } },
              e('input', { className: 'arc-text', style: { flex: 1 }, value: newPreset, placeholder: '新预设名称，如：深夜陪伴', maxLength: 40, onChange: (ev) => setNewPreset(ev.target.value) }),
              e(Btn, { label: '＋ 新建预设', small: true, kind: 'primary', onClick: () => void addPreset(), disabled: busy })),
          ),
          // 注入设置
          e(Card, { title: '📏 注入设置' },
            e(Row, { k: '每轮注入预算上限（字符）', v: capStr }),
            e('p', { className: 'arc-hint' }, '按顺序注入常驻/命中指令，超出预算即停止（首条保证注入）。调大更完整但更耗 token；建议 600~2000。'),
            e('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
              e('input', { className: 'arc-text', style: { flex: 1 }, value: capStr, onChange: (ev) => { setCapStr(ev.target.value.replace(/[^\d]/g, '')); setCapDirty(true); } }),
              e(Btn, { label: '保存上限', small: true, kind: 'primary', onClick: () => void saveCap(), disabled: busy })),
          ),
          // 指令列表
          e(Card, { title: `📋 指令（${data.entries.length} 条）`, right: e(Btn, { label: '＋ 新建指令', small: true, kind: 'primary', onClick: openNew, disabled: busy || !(data.activePresetId || data.presets.length > 0) }) },
            data.entries.length === 0
              ? e('p', { className: 'dim' }, '暂无指令。新建常驻指令（每轮必生效）或关键词指令（命中才生效）。')
              : e('div', null, data.entries.map((en) => e('div', { key: en.id, className: 'arc-item', style: { marginBottom: 6 } },
                e('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                  e('span', { className: 't1' }, en.enabled !== false ? en.name : `（停用）${en.name}`),
                  e(Badge, { text: MODE_LABEL[en.mode] ?? en.mode, tone: en.mode === 'keys' ? 'brand' : 'dim' }),
                  en.mode === 'keys' ? e(Badge, { text: (en.keys ?? []).join('、'), tone: 'brand' }) : null,
                  e(Badge, { text: SCOPE_LABEL[en.scope] ?? en.scope, tone: 'dim' }),
                  en.presetId === data.activePresetId ? e(Badge, { text: '当前预设', tone: 'good' }) : e(Badge, { text: presetName(en.presetId), tone: 'dim' }),
                ),
                e('div', { className: 'dim', style: { fontSize: 12.5, whiteSpace: 'pre-wrap', margin: '3px 0' } }, String(en.text ?? '').slice(0, 300)),
                e('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  e(Btn, { label: en.enabled !== false ? '停用' : '启用', small: true, onClick: () => toggleEnabled(en), disabled: busy }),
                  e(Btn, { label: '↑', small: true, title: '上移（同预设内）', onClick: () => moveEntry(en, -1), disabled: busy }),
                  e(Btn, { label: '↓', small: true, title: '下移（同预设内）', onClick: () => moveEntry(en, 1), disabled: busy }),
                  e(Btn, { label: '编辑', small: true, onClick: () => openEdit(en), disabled: busy }),
                  e(Btn, { label: '删除', small: true, kind: 'danger', onClick: () => delEntry(en), disabled: busy }))))),
          ),
          // 新建/编辑指令
          edit && e(Card, { title: edit.isNew ? '✏️ 新建指令' : `✏️ 编辑指令：${edit.name || ''}`, right: e(Btn, { label: '取消', small: true, onClick: () => setEdit(null) }) },
            e('div', { className: 't2', style: { marginBottom: 4 } }, '指令名称'),
            e('input', { className: 'arc-text', value: edit.name, maxLength: 40, placeholder: '如：简洁有力', onChange: (ev) => setEdit({ ...edit, name: ev.target.value }) }),
            e('div', { style: { display: 'flex', gap: 10, margin: '8px 0', flexWrap: 'wrap' } },
              e('label', null, '触发：',
                e('select', { value: edit.mode, onChange: (ev) => { const mode = ev.target.value; const scope = mode === 'keys' && edit.scope !== 'loop' ? 'loop' : edit.scope; setEdit({ ...edit, mode, scope }); } },
                  e('option', { value: 'always' }, '常驻（每轮生效）'),
                  e('option', { value: 'keys' }, '关键词触发（命中才生效）'))),
              e('label', null, '作用域：',
                e('select', { value: edit.scope, disabled: edit.mode === 'keys', onChange: (ev) => setEdit({ ...edit, scope: ev.target.value }) },
                  e('option', { value: 'loop' }, '思维循环'),
                  e('option', { value: 'both' }, '思维循环 + 对话回复'),
                  e('option', { value: 'dialogue' }, '仅对话回复')))),
            edit.mode === 'keys' && e('div', null,
              e('input', { className: 'arc-text', value: edit.keysText, placeholder: '关键词，用顿号或逗号分隔（如：外卖、工作、生气）', onChange: (ev) => setEdit({ ...edit, keysText: ev.target.value }) }),
              e('p', { className: 'arc-hint' }, '命中来源：你的消息、用户状态、近期用户消息；任一关键词出现即触发（上限 10 个）。')),
            e('textarea', { className: 'arc-text', style: { width: '100%', minHeight: 90, marginTop: 6, resize: 'vertical', boxSizing: 'border-box' }, maxLength: 1500, value: edit.text, placeholder: '指令内容：告诉 AI 该怎么做（风格/语气/禁忌/行动取舍）。如：主动发言必须简洁有力，一次只给一个建议。', onChange: (ev) => setEdit({ ...edit, text: ev.target.value }) }),
            e('div', { style: { display: 'flex', gap: 6, marginTop: 8 } },
              e(Btn, { label: '保存指令', small: true, kind: 'primary', onClick: () => void saveEntry(), disabled: busy }),
              e(Btn, { label: '取消', small: true, onClick: () => setEdit(null) })),
            edit.isNew && e('div', { style: { marginTop: 6 } },
              e('label', null, '归属预设：',
                e('select', { value: edit.presetId, onChange: (ev) => setEdit({ ...edit, presetId: ev.target.value }) },
                  data.presets.map((p) => e('option', { key: p.id, value: p.id }, p.name))))),
          ),
          // 命中预览
          e(Card, { title: '🔍 命中预览', right: data.activePresetId ? e(Badge, { text: `当前：${activeName}`, tone: 'good' }) : e(Badge, { text: '未启用预设', tone: 'dim' }) },
            e('div', { style: { display: 'flex', gap: 6 } },
              e('input', { className: 'arc-text', style: { flex: 1 }, value: previewText, placeholder: '输入一段模拟文本（如你的消息），查看哪些关键词指令会被激活', onChange: (ev) => setPreviewText(ev.target.value) }),
              e(Btn, { label: pvBusy ? '计算中…' : '模拟命中', small: true, kind: 'primary', onClick: () => void runPreview(), disabled: pvBusy || !data.activePresetId })),
            preview && e('div', { style: { marginTop: 8 } },
              preview.injected.length === 0
                ? e('p', { className: 'dim' }, '本次将不注入任何指令（常驻指令未配置或关键词均未命中）。')
                : e('div', null,
                    preview.injected.map((m) => e('div', { key: m.id, className: 'arc-item', style: { marginBottom: 4 } },
                      e('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                        e('span', { className: 't1' }, m.name),
                        e(Badge, { text: MODE_LABEL[m.mode] ?? m.mode, tone: m.mode === 'keys' ? 'brand' : 'dim' })))),
                  preview.truncated > 0 && e('p', { className: 'arc-hint' }, `另有 ${preview.truncated} 条因超出预算（${preview.injectCapChars} 字符）未注入。`),
                  e('p', { className: 'dim', style: { marginTop: 4 } }, `注入预算已用 ${preview.budgetUsed} / ${preview.injectCapChars} 字符。`))),
          ),
          err && e('p', { style: { color: 'var(--arc-err)', marginTop: 8 } }, err),
        );
      }

      function PageLoop({ rpc, showToast, askConfirm }) {
        const [stats, setStats] = useState(null);
        const [state, setState] = useState(null);
        const [busy, setBusy] = useState(false);
        const [intervalMs, setIntervalMs] = useState('');
        //：单次决策 token 预算编辑栏（推理模型 reasoning 会占用，默认 10000）
        const [maxTokens, setMaxTokens] = useState('');
        const [tab, setTab] = useState('status');
        const [history, setHistory] = useState(null);
        const [mode, setMode] = useState('idle'); //：活动流"思考进行中"占位
        const [preCap, setPreCap] = useState(''); //：对话前置思考时限（ms）编辑值
        const [preTok, setPreTok] = useState(''); //：对话前置思考单次预算编辑值

        const load = useCallback(async () => {
          setBusy(true);
          const [s1, s2] = await Promise.all([rpc('loop.stats'), rpc('loop.state')]);
          if (s1.ok) { setStats(s1.value); setIntervalMs(String(s1.value?.config?.fallbackIntervalMs ?? '')); setMaxTokens(String(s1.value?.config?.maxTokens ?? '')); setPreCap(String(s1.value?.config?.preTurnCapMs ?? '')); setPreTok(String(s1.value?.config?.preTurnMaxTokens ?? '')); }
          if (s2.ok) setState(s2.value);
          setBusy(false);
        }, [rpc]);
        const loadHistory = useCallback(async () => {
          const r = await rpc('loop.history', { limit: 60 });
          if (r.ok) setHistory(Array.isArray(r.value?.items) ? r.value.items : []);
          //：顺带取运行状态——思考进行中时活动流顶部显示占位（决策完成前即"可见"）
          const s = await rpc('loop.stats');
          if (s.ok && s.value?.mode) setMode(s.value.mode);
        }, [rpc]);
        useEffect(() => { void load(); }, [load]);
        //：活动流打开时每 5s 自动刷新——对话的前置思考（pre-turn）实时可见，不再需要手动点刷新
        useEffect(() => {
          if (tab !== 'history') return undefined;
          void loadHistory();
          const iv = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void loadHistory(); }, 5000);
          return () => clearInterval(iv);
        }, [tab, loadHistory]);

        const saveConfig = async () => {
          const v = Number(intervalMs);
          if (!Number.isFinite(v) || v < 1000) { showToast('兜底间隔必须 ≥ 1000ms'); return; }
          const mt = Number(maxTokens);
          if (maxTokens.trim() !== '' && (!Number.isFinite(mt) || mt < 1)) { showToast('maxTokens 必须 ≥ 1'); return; }
          //：前置思考参数双层校验（前端拦截 + Host configure 权威范围，见 PRE_* 常量）
          const pc = Number(preCap);
          if (preCap.trim() !== '' && (!Number.isFinite(pc) || pc < PRE_CAP_MIN || pc > PRE_CAP_MAX)) { showToast(`对话前置思考时限必须在 ${PRE_CAP_MIN / 1000} 秒 ~ ${PRE_CAP_MAX / 60000} 分钟之间`); return; }
          const pt = Number(preTok);
          if (preTok.trim() !== '' && (!Number.isFinite(pt) || pt < PRE_TOK_MIN || pt > PRE_TOK_MAX)) { showToast(`对话前置思考预算必须在 ${PRE_TOK_MIN} ~ ${PRE_TOK_MAX} 之间`); return; }
          const patch = { fallbackIntervalMs: v };
          if (maxTokens.trim() !== '') patch.maxTokens = Math.floor(mt);
          if (preCap.trim() !== '') patch.preTurnCapMs = Math.floor(pc);
          if (preTok.trim() !== '') patch.preTurnMaxTokens = Math.floor(pt);
          const r = await rpc('loop.configure', patch);
          if (r.ok) {
            showToast(`已更新：兜底 ${Math.round((r.value?.fallbackIntervalMs ?? 0) / 1000)}s · maxTokens=${r.value?.maxTokens ?? '-'} · 前置时限=${Math.round((r.value?.preTurnCapMs ?? 0) / 1000)}s · 前置预算=${r.value?.preTurnMaxTokens ?? '-'}`);
            void load();
          } else showToast(`配置失败：${r.error}`);
        };
        //：双 Agent 即时切换（持久化，无需重启）
        const toggleDualLoop = async () => {
          const next = !(stats?.config?.dualAgent === true);
          const r = await rpc('loop.configure', { dualAgent: next });
          if (r.ok) { showToast(next ? '双 Agent 已开启（记忆概括+输出审查）' : '双 Agent 已关闭（恢复单决策流程）'); void load(); }
          else showToast(`操作失败：${r.error}`);
        };
        const trigger = async () => {
          const r = await rpc('loop.trigger', { reason: 'webui-manual' });
          if (r.ok) { showToast('已触发一轮思考（完成后刷新状态）'); setTimeout(() => void load(), 6000); } else showToast(`触发失败：${r.error}`);
        };

        const d = state?.lastDecision ?? null;
        const guards = stats?.guards ?? {};
        const TRIGGER_LABEL = { startup: '启动', fallback: '定时兜底', 'state-changed': '状态变化', 'pre-turn': '对话前刷新', 'task-due': '任务到期', 'webui-manual': '手动触发', hour: '整点' };
        return e('div', null,
          e('div', { className: 'arc-tabs' },
            [['status', '运行状态'], ['history', `活动流${history ? ` (${history.length})` : ''}`], ['preset', '思维预设']].map(([id, label]) =>
              e('button', { key: id, className: `arc-tab${tab === id ? ' on' : ''}`, onClick: () => setTab(id) }, label))),
          tab === 'status' && [
            e(Stats, { key: 's', items: [
              { k: '状态', v: stats?.mode ?? '—' },
              { k: '睡眠', v: sleepLabelOf(state?.sleep) },
              { k: '静默窗口', v: (stats?.config?.quietAfterUserMs ?? 0) > 0 ? `用户消息/回合后 ${Math.round((stats.config.quietAfterUserMs ?? 60000) / 1000)}s${(state?.quietLeftMs ?? 0) > 0 ? ` · 静默中剩 ${Math.round(state.quietLeftMs / 1000)}s` : ''}` : '已关闭' },
              { k: '循环次数', v: stats?.cycleCount ?? 0 },
              { k: '失败次数', v: stats?.errorCount ?? 0 },
              { k: '中止次数', v: stats?.cancelledCount ?? 0 },
              { k: '上次循环', v: fmtTime(stats?.lastCycleAt) },
              { k: '上次决策', v: fmtTime(stats?.lastDecisionAt) },
              { k: '今日行动', v: guards.dayActions ?? 0 },
              { k: '上次发言', v: fmtTime(guards.lastSpeakAt) },
              { k: '模型', v: stats?.config?.model ?? '—' },
            ] }),
            e(Card, { key: 'cfg', title: '⚙️ 运行配置', right: e(Btn, { label: '保存配置', kind: 'primary', small: true, onClick: () => void saveConfig() }) },
              e(Row, { k: '兜底间隔 (ms)', v: intervalMs }),
              e(Row, { k: '当前生效间隔', v: `${Math.round((stats?.config?.effectiveFallbackMs ?? 300000) / 60000)} 分钟${stats?.config?.reducedMode ? '（降频模式，总控可关闭）' : ''}` }),
              e(Row, { k: '单次决策 token 预算', v: `${stats?.config?.maxTokens ?? 10000}${maxTokens.trim() !== '' && Number(maxTokens) !== (stats?.config?.maxTokens ?? 10000) ? '（未保存）' : ''}` }),
              e(Row, { k: '用户消息后静默 (s)', v: `${Math.round((stats?.config?.quietAfterUserMs ?? 60000) / 1000)} 秒（对话让路窗：用户消息/回合后短暂暂停时间驱动循环；防串线靠对话上下文注入，窗口仅兜底）` }),
              e(Row, { k: '对话前置思考时限', v: `${Math.round((stats?.config?.preTurnCapMs ?? 120000) / 1000)} 秒${preCap.trim() !== '' && Number(preCap) !== (stats?.config?.preTurnCapMs ?? 120000) ? '（未保存）' : ''}` }),
              e(Row, { k: '对话前置思考预算', v: `${stats?.config?.preTurnMaxTokens ?? 4000} tokens${preTok.trim() !== '' && Number(preTok) !== (stats?.config?.preTurnMaxTokens ?? 4000) ? '（未保存）' : ''}` }),
              e('div', { key: 'dual', style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 } },
                e('span', { className: 'dim', style: { fontSize: 12 } }, '🧠 双 Agent（记忆加工+输出审查）'),
                e('button', { className: `arc-btn small${stats?.config?.dualAgent === true ? ' danger' : ' primary'}`, onClick: () => void toggleDualLoop() }, stats?.config?.dualAgent === true ? '关闭（恢复单流程）' : '开启'),
                e('span', { className: 'arc-hint', style: { fontSize: 11 } }, stats?.config?.dualAgent === true ? '开启中：记忆先由 agent1 按 recent/语义概括，决策读概括，输出前审查（通顺/行动合理/不重复/符合人设/用户指令）；可配合「思维预设」注入你的指令' : '默认关=与旧流程一致；开启会略增耗时与 token')),
              e('div', { className: 'arc-text' }, '直接编辑下方数值并保存（全部运行时生效，无需重启）：'),
              e('input', { className: 'arc-text', value: intervalMs, onChange: (ev) => setIntervalMs(ev.target.value), placeholder: '如 300000（5 分钟）' }),
              e('input', { className: 'arc-text', style: { marginTop: 6 }, value: maxTokens, onChange: (ev) => setMaxTokens(ev.target.value), placeholder: `如 10000（deepseek-v4-flash 推理模型，reasoning 会占用预算，过小致正文截断→循环失败）` }),
              e('input', { className: 'arc-text', style: { marginTop: 6 }, value: preCap, onChange: (ev) => setPreCap(ev.target.value), placeholder: `如 120000（120 秒；限 ${PRE_CAP_MIN / 1000} 秒 ~ ${PRE_CAP_MAX / 60000} 分钟，乱填超大值会致每回合思考瞬间被砍）` }),
              e('input', { className: 'arc-text', style: { marginTop: 6 }, value: preTok, onChange: (ev) => setPreTok(ev.target.value), placeholder: `如 4000（越小完成越快；限 ${PRE_TOK_MIN} ~ ${PRE_TOK_MAX}）` }),
              e('p', { className: 'arc-hint' }, '兜底间隔：无事件时多久强制思考一轮；maxTokens：时间驱动决策预算；对话前置思考时限：每次对话消息的前置思考最晚多久完成（超时中止并在活动流留痕）；对话前置思考预算：该思考单次 token 上限（4000 完成较快；改大更深入但更慢）。tick/模型等需改 cordis.patch.yml 后重启。')),
            e(Card, { key: 'slp', title: '😴 睡眠/清醒期（2026-08-31，语义修正 09-03）' },
              e('p', { className: 'dim' }, state?.sleep?.phase === 'asleep'
                ? `用户睡眠状态持续 ≥30 分钟后进入睡眠期：思维循环完全暂停（无视降频开关、事件触发也跳过），定时任务照常触发并打断睡眠期。状态 TTL 到期≠醒来——仅用户发消息/状态清除或改标签/任务打断才解除（2026-09-03 修复夜行长睡眠被连环打扰）。`
                : `用户"睡眠中"状态持续 ≥${Math.round((stats?.config?.sleepEnterDelayMs ?? 1800000) / 60000)} 分钟且未来 ${Math.round((stats?.config?.sleepCheckWindowMs ?? 28800000) / 3600000)} 小时无 pending 任务 → 进入睡眠期（完全暂停主动循环）；解除=真实唤醒信号（用户发消息 / 状态清除或改标签 / 任务触发），状态 TTL 到期保持静默；仅无 TTL 的睡眠行超过 ${Math.round((stats?.config?.sleepMaxMs ?? 28800000) / 3600000)} 小时作为兜底强制解除；解除后进入 ${Math.round((stats?.config?.sleepCooldownMs ?? 10800000) / 3600000)} 小时强制清醒间隔（期间无法再睡眠）。`),
              state?.sleep?.phase === 'asleep'
                ? e('div', { className: 't2', style: { marginTop: 6 } }, e(Badge, { text: `已睡眠 ${fmtDur(state.sleep.asleepForMs)} · 静默中（等真实唤醒）`, tone: 'dim' }))
                : null,
              state?.sleep?.phase === 'cooldown'
                ? e('div', { className: 't2', style: { marginTop: 6 } }, e(Badge, { text: `强制清醒剩 ${fmtDur(state.sleep.cooldownLeftMs)}（打断原因：${state.sleep.wakeReason === 'task' ? '定时任务' : state.sleep.wakeReason === 'woke' ? '用户醒来' : state.sleep.wakeReason === 'user' ? '用户发消息' : state.sleep.wakeReason === 'timeout' ? '无TTL睡眠行超上限' : state.sleep.wakeReason || '—'}）`, tone: 'warn' }))
                : null,
              state?.sleep?.skips > 0
                ? e('p', { className: 'arc-hint', style: { marginTop: 6 } }, `睡眠期已暂停 ${state.sleep.skips} 次循环（省 token）。`)
                : null),
            e(Card, { key: 'trg', title: '▶️ 手动触发', right: e(Btn, { label: '触发一轮思考', kind: 'primary', small: true, onClick: () => void trigger() }) },
              e('p', { className: 'dim' }, '触发后 AI 会召回记忆 → 分析场景 → 决定行为（是否发言/行动）。触发即排队，循环异步执行。')),
            d && e(Card, { key: 'dec', title: '🧠 最近一次决策' },
              d.analysis ? e('p', { className: 'dim' }, String(d.analysis)) : null,
              e('div', { className: 't2', style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
                e(Badge, { text: d.shouldSpeak ? '拟发言' : '不发言', tone: d.shouldSpeak ? 'good' : 'dim' }),
                e(Badge, { text: d.shouldAct ? `拟行动 ${(d.actions ?? []).length} 项` : '不行动', tone: d.shouldAct ? 'warn' : 'dim' }),
                e('span', { className: 'arc-hint' }, d.notifyUser ? '将告知用户' : '静默行动')),
              Array.isArray(d.actions) && d.actions.length > 0
                ? e('div', { className: 'arc-list', style: { marginTop: 10 } },
                    d.actions.map((a, i) => e('div', { key: i, className: 'arc-item' },
                      e('div', { className: 't1' }, `${a.name}${a.args ? ' ' + JSON.stringify(a.args).slice(0, 120) : ''}`))))
                : null),
          ],
          tab === 'history' && e(Card, { title: '🕘 自循环活动流', right: e(Btn, { label: '↻ 刷新', small: true, onClick: () => void loadHistory() }) },
            mode === 'thinking'
              ? e('div', { key: 'thinking', className: 'arc-note', style: { marginBottom: 8, padding: '6px 10px', border: '1px dashed var(--arc-brand)', borderRadius: 8, color: 'var(--arc-brand)' } }, '🧠 思考循环进行中…（对话回合/定时触发的前置思考正在运行，完成后自动出现在下方）')
              : null,
            history === null ? e('p', { className: 'dim' }, '加载中…') :
            history.length === 0 ? e('p', { className: 'dim' }, '暂无活动记录（自循环决策会留档于此，随运行累积）') :
              e('div', { className: 'arc-tl' },
                history.map((h) => {
                  const p = parseLoopDecision(h.content);
                  const trg = p.trigger || '';
                  const trgLabel = TRIGGER_LABEL[trg] ?? trg;
                  return e('div', { key: h.id, className: 'arc-tl-item' },
                    e('div', { className: 't3' }, `${p.time || fmtTime(h.createdAt)}　${trgLabel ? e(Badge, { text: trgLabel, tone: 'brand' }) : ''}`),
                    p.analysis ? e('div', { className: 't1', style: { marginBottom: 3 } }, p.analysis) : null,
                    e('div', { className: 't4' }, [p.speak, p.act].filter(Boolean).join(' ／ ')),
                  );
                }))),
          tab === 'preset' && e(InstrPanel, { rpc, showToast, askConfirm }),
        );
      }

      // ================= 记忆 =================
      function PageMemory({ rpc, showToast, askConfirm }) {
        const [tab, setTab] = useState('memories');
        const [stats, setStats] = useState(null);
        const [list, setList] = useState([]);
        const [query, setQuery] = useState('');
        const [results, setResults] = useState(null);
        const [forgotten, setForgotten] = useState([]);
        const [profile, setProfile] = useState([]);
        const [snap, setSnap] = useState(null);
        const [busy, setBusy] = useState(false);
        const [editing, setEditing] = useState(null); // {id, content, importance, protected}
        const [qk, setQk] = useState('8');
        //：多选删除 + 记忆整合
        const [selected, setSelected] = useState([]);
        const [integrating, setIntegrating] = useState(false);

        const toggleSel = (id) => setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
        const deleteSelected = () => {
          if (selected.length === 0) return;
          const protCount = list.filter((m) => selected.includes(m.id) && m.protected).length;
          askConfirm(`删除选中的 ${selected.length} 条记忆？${protCount > 0 ? `\n⚠️ 其中 ${protCount} 条为受保护记忆（不可遗忘，删除后不可恢复）！` : ''}（不可恢复）`, async () => {
            const r = await rpc('memory.batchForget', { ids: selected });
            if (r.ok) { showToast(`已删除 ${r.value?.removed ?? 0} 条`); setSelected([]); void loadAll(); }
            else showToast(`删除失败：${r.error}`);
          });
        };
        const runIntegrate = async () => {
          setIntegrating(true);
          showToast('正在凝练最近的自循环思考记录…');
          const r = await rpc('memory.integrate');
          setIntegrating(false);
          if (r.ok) {
            if (r.value?.skipped) showToast(`整合跳过：${r.value?.reason ?? ''}`);
            else showToast(`整合完成：${r.value?.input ?? 0} 条 → 1 条语义记忆（软遗忘 ${r.value?.softened ?? 0} 条）`);
            void loadAll();
          } else showToast(`整合失败：${r.error}`);
        };

        const loadAll = useCallback(async () => {
          setBusy(true);
          const [s, l, f, p, sn] = await Promise.all([
            rpc('memory.stats'), rpc('memory.list', { limit: 60 }), rpc('memory.forgottenList', { limit: 40 }),
            rpc('memory.profile'), rpc('memory.state'),
          ]);
          if (s.ok) setStats(s.value);
          if (l.ok) setList(Array.isArray(l.value) ? l.value : []);
          if (f.ok) setForgotten(Array.isArray(f.value) ? f.value : []);
          if (p.ok) setProfile(Array.isArray(p.value) ? p.value : []);
          if (sn.ok) setSnap(sn.value);
          setBusy(false);
        }, [rpc]);
        useEffect(() => { void loadAll(); }, [loadAll]);

        const doRecall = async () => {
          const q = query.trim();
          if (!q) { showToast('请输入检索关键词'); return; }
          setBusy(true);
          const r = await rpc('memory.recall', { query: q, k: Number(qk) || 8, mode: 'hybrid' });
          setBusy(false);
          if (r.ok) { setResults(r.value?.results ?? []); } else showToast(`检索失败：${r.error}`);
        };
        const saveEdit = async (id) => {
          if (!editing) return;
          const r = await rpc('memory.update', { id, patch: { content: editing.content, importance: Number(editing.importance), protected: editing.protected } });
          if (r.ok) { showToast('已保存'); setEditing(null); void loadAll(); } else showToast(`保存失败：${r.error}`);
        };
        const forgetOne = async (id, content, isProtected) => {
          askConfirm(`${isProtected ? '⚠️ 该记忆受保护（不可遗忘），确认删除？\n' : '删除该记忆？\n'}${truncate(content, 60)}`, async () => {
            const r = await rpc('memory.forget', { id });
            if (r.ok) { showToast('已删除'); void loadAll(); } else showToast(`删除失败：${r.error}`);
          });
        };
        const runForget = () => {
          askConfirm('执行一次仿生遗忘作业：重算全库强度、软遗忘/归档弱记忆。不可撤销（可恢复）。', async () => {
            const r = await rpc('memory.forgetRun');
            if (r.ok) { const v = r.value ?? {}; showToast(`完成：软遗忘 ${v.softened ?? 0}，归档 ${v.archived ?? 0}`); void loadAll(); } else showToast(`作业失败：${r.error}`);
          });
        };
        const restoreOne = async (id) => {
          const r = await rpc('memory.restore', { id });
          if (r.ok) { showToast(r.value?.restored ? '已恢复' : '恢复失败'); void loadAll(); } else showToast(`恢复失败：${r.error}`);
        };

        const memItem = (m, actions) => e('div', { key: m.id, className: `arc-item${selected.includes(m.id) ? ' arc-sel' : ''}` },
          editing && editing.id === m.id
            ? e('div', null,
                e('textarea', { className: 'arc-textarea', value: editing.content, onChange: (ev) => setEditing({ ...editing, content: ev.target.value }) }),
                e('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                  e('input', { className: 'arc-text', style: { width: 80, margin: 0 }, title: '重要度 0~1', value: editing.importance, onChange: (ev) => setEditing({ ...editing, importance: ev.target.value }) }),
                  e('label', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--arc-dim)' } },
                    e('input', { type: 'checkbox', checked: editing.protected, onChange: (ev) => setEditing({ ...editing, protected: ev.target.checked }) }), '保护（不可遗忘）'),
                  e(Btn, { label: '保存', kind: 'primary', small: true, onClick: () => void saveEdit(m.id) }),
                  e(Btn, { label: '取消', small: true, onClick: () => setEditing(null) })))
            : e('div', null,
                e('div', { className: 't1', style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
                  e('input', { type: 'checkbox', style: { marginTop: 3 }, checked: selected.includes(m.id), onChange: () => toggleSel(m.id), title: '多选（可批量删除）' }),
                  e('span', null, m.content)),
                e('div', { className: 't2' },
                  e(Badge, { text: KIND_LABEL[m.kind] ?? m.kind, tone: 'brand' }),
                  m.protected ? e(Badge, { text: '保护', tone: 'good' }) : null,
                  m.forgotten === 1 ? e(Badge, { text: '软遗忘', tone: 'warn' }) : null,
                  m.forgotten === 2 ? e(Badge, { text: '归档', tone: 'dim' }) : null,
                  m.score != null ? e('span', null, `相关度 ${(m.score * 100).toFixed(0)}%`) : null,
                  m.relativeTime ? e('span', null, m.relativeTime) : null,
                  e('span', null, fmtTime(m.createdAt)),
                  m.tags && m.tags.length > 0 ? e('span', null, `#${m.tags.join(' #')}`) : null,
                  e('span', null, `强度 ${(m.strength ?? 0).toFixed(2)}`)),
                actions ? e('div', { className: 'ops' }, actions(m)) : null));

        return e('div', null,
          e(Stats, { items: stats ? [
            { k: '总记忆', v: stats.total ?? 0 },
            { k: '事件', v: stats.byKind?.episodic ?? 0 },
            { k: '语义', v: stats.byKind?.semantic ?? 0 },
            { k: '想法', v: stats.byKind?.thought ?? 0 },
            { k: '程序', v: stats.byKind?.procedural ?? 0 },
            { k: '偏好', v: stats.byKind?.preference ?? 0 },
            { k: 'FTS5', v: stats.fts ? '开' : '关' },
          ] : [] }),
          e('div', { className: 'arc-tabs' },
            [['memories', '记忆'], ['search', '语义检索'], ['forgotten', `遗忘(${forgotten.length})`], ['profile', `画像(${profile.length})`], ['state', '用户状态']].map(([id, label]) =>
              e('button', { key: id, className: `arc-tab${tab === id ? ' on' : ''}`, onClick: () => setTab(id) }, label))),
          tab === 'memories' && e(Card, { title: '📚 最近记忆', right: e('div', { style: { display: 'flex', gap: 6 } },
            e(Btn, { label: '🧬 整合', small: true, disabled: integrating, onClick: () => void runIntegrate() }),
            e(Btn, { label: '↻ 刷新', small: true, onClick: () => void loadAll() }),
            e(Btn, { label: '🕸 遗忘作业', small: true, onClick: () => runForget() })) },
            selected.length > 0 && e('div', { className: 'arc-note', style: { margin: '0 0 8px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              e('span', null, `已选 ${selected.length} 条`),
              (() => { const pc = list.filter((m) => selected.includes(m.id) && m.protected).length; return pc > 0 ? e('span', { style: { color: 'var(--arc-err)' } }, `⚠️ 含 ${pc} 条受保护`) : null; })(),
              e(Btn, { label: '删除所选', kind: 'danger', small: true, onClick: () => void deleteSelected() }),
              e(Btn, { label: '取消选择', small: true, onClick: () => setSelected([]) })),
            list.length === 0 ? e('p', { className: 'dim' }, '暂无记忆') :
              e('div', { className: 'arc-list' }, list.map((m) => memItem(m, () => [
                e(Btn, { key: 'e', label: '编辑', small: true, onClick: () => setEditing({ id: m.id, content: m.content, importance: String(m.importance ?? 0.5), protected: !!m.protected }) }),
                e(Btn, { key: 'd', label: '删除', kind: 'danger', small: true, onClick: () => void forgetOne(m.id, m.content, !!m.protected) }),
              ])))),
          tab === 'search' && e(Card, { title: '🔎 语义 + 关键词混合检索', right: e(Btn, { label: busy ? '检索中…' : '检索', kind: 'primary', small: true, onClick: () => void doRecall() }) },
            e('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              e('input', { className: 'arc-text', style: { flex: 1, margin: 0 }, placeholder: '检索内容关键词…', value: query, onChange: (ev) => setQuery(ev.target.value), onKeyDown: (ev) => { if (ev.key === 'Enter') void doRecall(); } }),
              e('input', { className: 'arc-text', style: { width: 70, margin: 0 }, title: '返回条数', value: qk, onChange: (ev) => setQk(ev.target.value) })),
            e('p', { className: 'arc-hint' }, '混合检索 = 向量语义 + FTS5 关键词；结果带相关度与相对时间，软遗忘记忆默认不进入。'),
            results != null && e('div', { style: { marginTop: 10 } },
              results.length === 0 ? e('p', { className: 'dim' }, '无结果') :
                e('div', { className: 'arc-list' }, results.map((m) => memItem(m, null))))),
          tab === 'forgotten' && e(Card, { title: '🗑 遗忘/归档区（可恢复）' },
            forgotten.length === 0 ? e('p', { className: 'dim' }, '暂无被遗忘记忆') :
              e('div', { className: 'arc-list' }, forgotten.map((m) => memItem(m, () => [
                e(Btn, { key: 'r', label: '恢复', kind: 'primary', small: true, onClick: () => void restoreOne(m.id) }),
              ])))),
          tab === 'profile' && e(Card, { title: '👤 用户画像', right: e(Btn, { label: '↻', small: true, onClick: () => void loadAll() }) },
            profile.length === 0 ? e('p', { className: 'dim' }, '暂无画像事实（多证据 ≥2 才入库）') :
              e('div', { className: 'arc-list' },
                profile.map((p) => e('div', { key: p.id, className: 'arc-item' },
                  e('div', { className: 't1' }, e('span', { className: 'arc-tag', style: { marginRight: 6 } }, p.key), p.content),
                  e('div', { className: 't2' },
                    e('span', null, `证据 ×${p.evidenceCount ?? 0}`),
                    e('span', null, `置信 ${pct(p.confidence)}`),
                    e('span', null, `更新 ${fmtTime(p.updatedAt)}`)))))),
          tab === 'state' && e(Card, { title: '⏱ 用户当前状态（TTL 过期）' },
            e('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 } },
              e('div', null, e('div', { className: 'arc-hint', style: { marginBottom: 6 } }, '有效状态'),
                (snap?.states ?? []).length === 0 ? e('p', { className: 'dim' }, '无') :
                  e('div', { className: 'arc-list' }, snap.states.map((s) => e('div', { key: s.id, className: 'arc-item' },
                    e('div', { className: 't1' }, e('span', { className: 'arc-tag', style: { marginRight: 6 } }, s.state), s.detail ?? ''),
                    e('div', { className: 't2' },
                      e('span', null, `置信 ${pct(s.confidence)}`),
                      s.expiresAt ? e('span', null, `至 ${fmtTime(s.expiresAt)}`) : e('span', null, '不过期'),
                      s.evidence ? e('span', null, `证据：${truncate(s.evidence, 30)}`) : null)))),
              e('div', null, e('div', { className: 'arc-hint', style: { marginBottom: 6 } }, '注入快照（每回合给 AI 看）'),
                snap?.rendered ? e('pre', { className: 'arc-textarea', style: { whiteSpace: 'pre-wrap', minHeight: 120 } }, snap.rendered) : e('p', { className: 'dim' }, '无注入内容'))))),
        );
      }

      // ================= 自进化 =================
      function PageEvolution({ rpc, showToast, askConfirm }) {
        const [data, setData] = useState(null); // {records}
        const [stats, setStats] = useState(null);
        const [busy, setBusy] = useState(false);
        const [filter, setFilter] = useState('all');
        const [tab, setTab] = useState('candidates'); // candidates | history（ 采纳记录）
        //  潜意识系统（梦境引擎）：状态 + Phi 模型状态 + 最近草案
        const [sub, setSub] = useState(null);
        const [model, setModel] = useState(null);
        const [subLog, setSubLog] = useState(null);
        const [dlBusy, setDlBusy] = useState(false);

        const load = useCallback(async () => {
          setBusy(true);
          const [v, s, sc, md, sl] = await Promise.all([rpc('evolution.view', { limit: 60 }), rpc('evolution.stats'), rpc('subconscious.state'), rpc('subconscious.model'), rpc('subconscious.log', { limit: 5 })]);
          if (v.ok) setData(v.value); else showToast(`加载失败：${v.error}`);
          if (s.ok) setStats(s.value);
          if (sc.ok) setSub(sc.value);
          if (md.ok) setModel(md.value);
          if (sl.ok) setSubLog(sl.value);
          setBusy(false);
        }, [rpc, showToast]);
        useEffect(() => { void load(); }, [load]);

        const suggest = () => {
          //  修复：suggest 是约 2 分钟长 RPC——此前服务端完成后若响应丢失/超时，前端不 toast 不刷新，
          // 候选生成了也看不见（"点了没反应"）。兜底：①15s 进行中提示 ②180s 上限 ③无论成败/超时都强制刷新列表。
          askConfirm('触发一次自进化建议：AI 依据记忆与人格生成候选（不生效），随后逐条隔离评估。', async () => {
            let hint = null;
            try {
              hint = setTimeout(() => showToast('正在生成候选（通常 1–2 分钟），完成后会自动刷新'), 15000);
              const r = await Promise.race([
                rpc('evolution.suggest', { by: 'webui' }),
                new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: '等待服务端超时（候选可能已生成，正在刷新查看）' }), 180000)),
              ]);
              if (r.ok) showToast(`已生成 ${r.value?.candidateIds?.length ?? 0} 条候选，已发通知`);
              else showToast(`生成失败或超时：${r.error ?? '未知错误'}`);
            } finally {
              if (hint) clearTimeout(hint);
              void load(); // 成功/失败/超时都强制刷新：候选由服务端落账，刷新即可见
            }
          });
        };
        const approve = (c) => {
          askConfirm(`采纳该候选？\n类型：${TYPE_LABEL[c.candidate?.type] ?? c.candidate?.type}${c.candidate?.refineId ? `（修正条目 ${String(c.candidate.refineId).slice(0, 8)}…）` : ''}\n内容：${truncate(c.candidate?.content ?? '', 100)}`, async () => {
            const r = await rpc('evolution.approve', { candidateId: c.id, confirm: true });
            if (r.ok) { showToast('已采纳'); void load(); } else showToast(`采纳失败：${r.error}`);
          });
        };
        const reject = (c) => {
          askConfirm(`拒绝该候选？\n${truncate(c.candidate?.content ?? '', 80)}`, async () => {
            const r = await rpc('evolution.reject', { candidateId: c.id });
            if (r.ok) { showToast('已拒绝'); void load(); } else showToast(`拒绝失败：${r.error}`);
          });
        };
        const doRollback = (c) => {
          askConfirm('回滚该已采纳候选？（人格回滚到采纳前版本 / 技能恢复原内容）', async () => {
            const r = await rpc('evolution.rollback', { candidateId: c.id, confirm: true });
            if (r.ok) { showToast('已回滚'); void load(); } else showToast(`回滚失败：${r.error}`);
          });
        };

        const byStatus = stats?.byStatus ?? {};
        //  修复：候选状态由最新审批动作记录（approve/reject/rollback/fail/auto-apply）派生——
        // suggest 记录自身的 status 恒为 pending，直接读会令已采纳/已拒绝/已回滚的候选一直显示"待审批"。
        const _allRecs = data?.records ?? [];
        const _statusMap = {};
        for (const r of _allRecs) if (['approve', 'reject', 'rollback', 'fail', 'auto-apply'].includes(r.type)) _statusMap[r.candidateId] = r.status;
        //  评估（decision/evaluation）是独立 evaluate 记录（按 candidateId 关联），
        // 不挂在 suggest 行上——此前渲染 c.decision 恒空，"评估"永不显示。
        const _evalMap = {};
        for (const r of _allRecs) if (r.type === 'evaluate' && r.candidateId) _evalMap[r.candidateId] = { decision: r.decision, evaluation: r.evaluation };
        const records = _allRecs.filter((r) => r.type === 'suggest').map((r) => {
          const evalRow = _evalMap[r.id];
          return { ...r, status: _statusMap[r.id] ?? r.status ?? 'pending', ...(evalRow ? { decision: evalRow.decision, evaluation: evalRow.evaluation } : {}) };
        });
        const shown = filter === 'all' ? records : records.filter((r) => (r.status ?? 'pending') === filter);
        const statusText = (r) => {
          const map = { pending: '待审批', applied: '已采纳', rejected: '已拒绝', 'rolled-back': '已回滚', failed: '失败' };
          return map[r.status ?? 'pending'] ?? r.status ?? 'pending';
        };
        //  人格进化拆分：候选类型显示标签（add=新增 / refine=修正既有条目）
        const TYPE_LABEL = { 'persona-add': '人格新增', 'persona-refine': '人格修正', 'skill-create': '技能新建', 'skill-improve': '技能改进' };
        //  潜意识操作
        const toggleAutoApply = async () => {
          const next = !(sub?.autoApply === true);
          const r = await rpc('subconscious.configure', { autoApply: next });
          if (r.ok) { setSub(r.value); showToast(next ? '自动微调已开启（自洽>95 且方向一致时系统先行执行，仅 persona 类）' : '自动微调已关闭（所有灵感草案均需人工审批）'); }
          else showToast(`操作失败：${r.error}`);
        };
        const setCondenseModel = async (m) => {
          const r = await rpc('subconscious.configure', { condenseModel: m });
          if (r.ok) { setSub(r.value); showToast(m === 'phi' ? '凝缩已切换为本地 Phi-3:mini' : '凝缩已切换为 DeepSeek'); }
          else showToast(`操作失败：${r.error}`);
        };
        const setLlmModel = async (m) => {
          const r = await rpc('subconscious.configure', { llmModel: m });
          if (r.ok) { setSub(r.value); showToast(m === 'phi' ? '碰撞/呓语已切换为本地 Phi-3:mini' : '碰撞/呓语已切换为 DeepSeek'); }
          else showToast(`操作失败：${r.error}`);
        };
        const toggleSubEnabled = async () => {
          const next = !(sub?.enabled === true);
          const r = await rpc('subconscious.configure', { enabled: next });
          if (r.ok) { setSub(r.value); showToast(next ? '潜意识系统已开启（睡眠期自动运行）' : '潜意识系统已关闭'); }
          else showToast(`操作失败：${r.error}`);
        };
        const downloadPhi = async () => {
          setDlBusy(true);
          const r = await rpc('subconscious.modelDownload');
          setDlBusy(false);
          //  模型管理失败不抛错（返回 {ok:false} 值级结果）——须检查 r.value
          if (r.ok && r.value?.ok) { showToast('Phi-3:mini 下载已开始（完成后状态自动更新）'); void load(); }
          else showToast(`下载失败：${r.value?.error ?? r.error ?? '未知错误'}`);
        };
        const removePhi = () => {
          askConfirm('删除本地 Phi-3:mini 模型（约 2GB）？删除后凝缩如需本地模型将自动重新下载。', async () => {
            const r = await rpc('subconscious.modelRemove');
            if (r.ok && r.value?.removed === true) { showToast('已删除 Phi-3:mini'); void load(); }
            else showToast(`删除失败：${r.value?.error ?? r.error ?? '未知错误'}`);
          });
        };
        const runDream = async () => {
          const r = await rpc('subconscious.run');
          if (r.ok) { showToast('梦境引擎已触发（凝缩+碰撞+调度，后台执行）'); setTimeout(() => void load(), 4000); }
          else showToast(`触发失败：${r.error}`);
        };
        return e('div', null,
          e('div', { className: 'arc-tabs' },
            [['candidates', '候选列表'], ['history', `采纳记录`]].map(([id, label]) =>
              e('button', { key: id, className: `arc-tab${tab === id ? ' on' : ''}`, onClick: () => setTab(id) }, label))),
          tab === 'candidates' && [
            e(Stats, { key: 's', items: [
              { k: '候选总数', v: stats?.totalCandidates ?? 0 },
              { k: '待审批', v: byStatus.pending ?? 0 },
              { k: '已采纳', v: byStatus.applied ?? 0 },
              { k: '已拒绝', v: byStatus.rejected ?? 0 },
              { k: '已回滚', v: byStatus['rolled-back'] ?? 0 },
              { k: '下次自动生成', v: stats?.auto?.enabled ? fmtTime(stats.auto.nextAutoAt) : '未启用' },
              { k: '自动已生成', v: stats?.auto?.autoTotal ?? 0 },
            ] }),
            e(Card, { key: 'act', title: '✨ 自进化（用户授权制）', right: e(Btn, { label: busy ? '处理中…' : '触发建议', kind: 'primary', small: true, onClick: () => suggest() }) },
              e('p', { className: 'dim' }, '候选生成 → 隔离评估 → 安全门 → 必须由你显式批准才生效；任何候选均不自动采纳。'),
              stats?.auto?.enabled
                ? e('p', { className: 'dim' }, `🤖 每日 ${String(stats.auto.autoHour).padStart(2, '0')}:00 自动生成候选并通知（人格←近24h对话+人格轨迹，模型产出 YAML 新增/修正方案；skill←对话/工作提炼），采纳仍需你批准。`)
                : null),
            e(Card, { key: 'list', title: '📋 候选列表', right: e('div', { style: { display: 'flex', gap: 4 } },
              ['all', 'pending', 'applied', 'rejected', 'rolled-back'].map((f) =>
                e(Btn, { key: f, label: f === 'all' ? '全部' : f, small: true, onClick: () => setFilter(f), disabled: filter === f }))) },
              shown.length === 0 ? e('p', { className: 'dim' }, '无候选记录') :
                e('div', { className: 'arc-list' },
                  shown.map((c) => {
                    const cand = c.candidate ?? {};
                    const status = c.status ?? 'pending';
                    const tone = STATUS_TONE[status] ?? 'dim';
                    return e('div', { key: c.id, className: 'arc-item' },
                      e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 } },
                        e(Badge, { text: statusText(c), tone }),
                        e(Badge, { text: TYPE_LABEL[cand.type] ?? cand.type ?? '?', tone: 'brand' }),
                        c.by === 'dream' ? e(Badge, { text: '🌙 灵感进化', tone: 'brand' }) : null,
                        cand.type === 'persona-refine' && cand.refineId ? e('span', { className: 'arc-hint' }, `修正 ${String(cand.refineId).slice(0, 8)}…`) : null,
                        e('span', { className: 'arc-hint' }, fmtFull(c.at)),
                        e('span', { className: 'arc-hint' }, `by ${c.by ?? '?'}`)),
                      cand.content ? e('div', { className: 't1', style: { fontFamily: 'var(--arc-mono)', fontSize: 12.5 } }, cand.content) : null,
                      cand.rationale ? e('div', { className: 'arc-note', style: { marginTop: 4 } }, `理由：${cand.rationale}`) : null,
                      cand.evidence ? e('div', { className: 'arc-note' }, `依据：${truncate(cand.evidence, 160)}`) : null,
                      c.decision ? e('div', { className: 't2', style: { marginTop: 6 } },
                        e('span', null, `评估：${c.decision.decision ?? c.decision.verdict ?? ''}`),
                        e('span', null, c.decision.reasons ? truncate(String(c.decision.reasons).slice(0, 120), 120) : '')) : null,
                      status === 'pending' && e('div', { className: 'ops' },
                        e(Btn, { label: '✓ 批准', kind: 'primary', small: true, onClick: () => void approve(c) }),
                        e(Btn, { label: '✕ 拒绝', kind: 'danger', small: true, onClick: () => void reject(c) })),
                      status === 'applied' && e('div', { className: 'ops' },
                        e(Btn, { label: '↩ 回滚', small: true, onClick: () => void doRollback(c) })),
                    );
                  }))),
            e(Card, { key: 'sub', title: '🌙 潜意识 · 梦境引擎（2026-08-31）', right: e(Btn, { label: sub?.enabled ? '关闭' : '开启', kind: sub?.enabled ? 'danger' : 'primary', small: true, onClick: () => void toggleSubEnabled() }) },
              e('p', { className: 'dim' }, sub?.enabled
                ? `睡眠期自动运行：高频记忆凝缩（${sub?.condenseModel === 'phi' ? '本地 Phi-3:mini' : 'DeepSeek'}）→ 异质碰撞（${sub?.llmModel === 'phi' ? '本地 Phi-3:mini' : 'DeepSeek'}）→ 置信度调度入进化队列；苏醒生成梦境呓语，话题相关时隐式注入。潜记忆池 ${sub?.poolCount ?? 0} 条，草案 ${sub?.draftCount ?? 0} 条，已碰撞 ${sub?.stats?.collisions ?? 0} 次，已导入进化 ${sub?.stats?.imported ?? 0} 条，自动微调 ${sub?.stats?.autoApplied ?? 0} 条，呓语注入 ${sub?.stats?.injects ?? 0} 次。`
                : '已关闭：睡眠期不运行梦境引擎（可手动触发下方「跑一次梦境」）。'),
              sub?.whisper
                ? e('div', { className: 't2', style: { marginTop: 4 } }, e('span', { className: 'arc-note', style: { color: 'var(--arc-faint)' } }, `🫧 最近呓语（${fmtTime(sub.whisper.at)}${sub.whisper.consumed ? ' · 已注入' : ' · 待注入'}）：${sub.whisper.text}`))
                : null,
              e('div', { className: 't2', style: { gap: 8, flexWrap: 'wrap', marginTop: 8 } },
                e(Badge, { text: sub?.autoApply ? '自动微调：开（自洽>95 自动执行 persona）' : '自动微调：关（所有草案需人工审批）', tone: sub?.autoApply ? 'warn' : 'dim' }),
                e(Badge, { text: model?.installed ? `Phi-3:mini 已装（${model?.sizeMb ?? '?'}MB）` : 'Phi-3:mini 未安装', tone: model?.installed ? 'good' : 'err' })),
              e('div', { className: 'ops', style: { marginTop: 8 } },
                e(Btn, { label: sub?.autoApply ? '关闭自动微调' : '开启自动微调', small: true, onClick: () => void toggleAutoApply() }),
                e(Btn, { label: '凝缩：' + (sub?.condenseModel === 'phi' ? 'Phi' : 'DeepSeek'), small: true, onClick: () => void setCondenseModel(sub?.condenseModel === 'phi' ? 'deepseek' : 'phi') }),
                e(Btn, { label: '碰撞/呓语：' + (sub?.llmModel === 'phi' ? 'Phi' : 'DeepSeek'), small: true, onClick: () => void setLlmModel(sub?.llmModel === 'phi' ? 'deepseek' : 'phi') }),
                model?.installed
                  ? e(Btn, { label: '🗑 删除 Phi-3:mini', kind: 'danger', small: true, onClick: () => void removePhi() })
                  : e(Btn, { label: dlBusy || model?.downloading ? '下载中…' : '📥 下载 Phi-3:mini（约 2GB）', kind: 'primary', small: true, disabled: dlBusy || model?.downloading, onClick: () => void downloadPhi() }),
                e(Btn, { label: '🌙 跑一次梦境', small: true, onClick: () => void runDream() })),
              e('p', { className: 'arc-hint', style: { marginTop: 6 } }, '自动微调默认关闭（符合"绝不自动采纳"原则）：开启后自洽>95 且与最近 3 次进化方向一致时系统先行执行（仅 persona 类，skill 类始终需人工审批）；执行结果在采纳记录以「自动微调」单列，可随时回滚。删除 Phi 模型前会二次确认。'),
              (Array.isArray(subLog?.drafts) && subLog.drafts.length > 0)
                ? e('div', { className: 'arc-list', style: { marginTop: 8 } },
                    subLog.drafts.slice().reverse().map((d, i) => e('div', { key: `${d.at}-${i}`, className: 'arc-item' },
                      e('div', { className: 't2' },
                        e(Badge, { text: ({ high: '高优先级待审批', 'auto-applied': '已自动微调', skip: '未达标', 'skip-bad-section': '非法分区' })[d.verdict] ?? d.verdict, tone: d.verdict === 'auto-applied' ? 'brand' : d.verdict === 'high' ? 'good' : 'dim' }),
                        e('span', null, fmtTime(d.at)),
                        e('span', { className: 'arc-hint' }, `自洽 ${d.selfConsistency ?? '—'} / 新颖 ${d.novelty ?? '—'}`)),
                      d.content ? e('div', { className: 't1', style: { fontSize: 12.5 } }, truncate(String(d.content), 120)) : null)))
                : null,
            ),
          ],
          tab === 'history' && e(Card, { title: '📜 采纳记录（最近审批）', right: e(Btn, { label: '↻ 刷新', small: true, onClick: () => void load() }) },
            (() => {
              const acts = (data?.records ?? []).filter((r) => ['approve', 'reject', 'rollback', 'fail', 'auto-apply'].includes(r.type)).slice(0, 30);
              if (acts.length === 0) return e('p', { className: 'dim' }, '暂无审批记录（采纳/拒绝/回滚/自动微调会记录于此）。');
              return e('div', { className: 'arc-list' },
                acts.map((a) => {
                  const label = { approve: '已采纳', reject: '已拒绝', rollback: '已回滚', fail: '失败', 'auto-apply': '🤖 自动微调' }[a.type] ?? a.type;
                  const tone = { approve: 'good', reject: 'err', rollback: 'dim', fail: 'err', 'auto-apply': 'brand' }[a.type] ?? 'dim';
                  return e('div', { key: `${a.id}-${a.at}`, className: 'arc-item' },
                    e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 } },
                      e(Badge, { text: label, tone }),
                      e(Badge, { text: TYPE_LABEL[a.candidate?.type] ?? a.candidate?.type ?? '?', tone: 'brand' }),
                      e('span', { className: 'arc-hint' }, fmtFull(a.at)),
                      e('span', { className: 'arc-hint' }, `by ${a.by ?? '?'}`)),
                    a.candidate?.content ? e('div', { className: 't1', style: { fontSize: 12.5 } }, truncate(String(a.candidate.content), 200)) : null,
                    a.to ? e('div', { className: 't2' }, e('span', null, `结果：${JSON.stringify(a.to)?.slice(0, 120) ?? ''}`)) : null,
                    a.error ? e('div', { className: 't2' }, e('span', { style: { color: 'var(--arc-err)' } }, `错误：${a.error}`)) : null,
                  );
                }));
            })()),
        );
      }

      // ================= 人格一致性 =================
      /** 轨迹散点图（PCA 前 2 维；turn=蓝点，waypoint=琥珀星形）。
       *   修复拉伸：canvas 内部分辨率曾固定 640×240，而 CSS width:100% 会把
       *  显示宽度拉大到卡片全宽 → 内部坐标系与显示尺寸不一致，点/文字被横向拉伸数倍。
       *  现按显示尺寸（clientWidth×固定高度 240）重设内部分辨率（×devicePixelRatio 保清晰），
       *  绘制经 ctx.scale 归一化，任何容器宽度下都不再变形。 */
      function drawScatter(canvas, points) {
        if (!canvas || !Array.isArray(points) || points.length === 0) return;
        const ctx2 = canvas.getContext('2d');
        const dpr = (globalThis.devicePixelRatio || 1);
        const dispW = Math.max(64, canvas.clientWidth || 640);
        const dispH = Math.max(64, canvas.clientHeight || 240);
        // 内部分辨率 = 显示尺寸 × dpr（避免 CSS 拉伸 + 高分屏模糊）
        if (canvas.width !== Math.round(dispW * dpr) || canvas.height !== Math.round(dispH * dpr)) {
          canvas.width = Math.round(dispW * dpr);
          canvas.height = Math.round(dispH * dpr);
        }
        ctx2.setTransform(dpr, 0, 0, dpr, 0, 0); // 绘制坐标回到 CSS 像素
        const W = dispW; const H = dispH;
        ctx2.clearRect(0, 0, W, H);
        const xs = points.map((p) => p.x); const ys = points.map((p) => p.y);
        let minX = Math.min(...xs); let maxX = Math.max(...xs);
        let minY = Math.min(...ys); let maxY = Math.max(...ys);
        if (maxX === minX) { maxX += 1; minX -= 1; }
        if (maxY === minY) { maxY += 1; minY -= 1; }
        const pad = 34;
        const sx = (x) => pad + ((x - minX) / (maxX - minX)) * (W - pad * 2);
        const sy = (y) => H - pad - ((y - minY) / (maxY - minY)) * (H - pad * 2);
        for (const p of points) {
          const x = sx(p.x); const y = sy(p.y);
          ctx2.beginPath();
          if (p.kind === 'waypoint') {
            ctx2.fillStyle = '#f7ad31';
            ctx2.arc(x, y, 6, 0, Math.PI * 2);
            ctx2.fill();
            ctx2.strokeStyle = 'rgba(0,0,0,0.35)';
            ctx2.lineWidth = 1;
            ctx2.stroke();
          } else {
            ctx2.fillStyle = '#5686fe';
            ctx2.arc(x, y, 3.5, 0, Math.PI * 2);
            ctx2.fill();
          }
        }
        ctx2.fillStyle = 'rgba(255,255,255,0.55)';
        ctx2.font = '11px sans-serif';
        ctx2.fillText('● 交互轨迹点     ★ 进化航点（已批准建议）', pad, H - 8);
      }
      function PageConsistency({ rpc, showToast, askConfirm }) {
        const [st, setSt] = useState(null);
        const [log, setLog] = useState(null);
        const [pca, setPca] = useState(null);
        const [alphaIn, setAlphaIn] = useState('');
        const [betaIn, setBetaIn] = useState('');
        const canvasRef = useRef(null);
        const load = useCallback(async () => {
          const [s, l, p] = await Promise.all([rpc('consistency.state'), rpc('consistency.log', { limit: 30 }), rpc('consistency.pca')]);
          if (s.ok) { setSt(s.value); setAlphaIn(s.value.alpha != null ? String(s.value.alpha) : ''); setBetaIn(s.value.beta != null ? String(s.value.beta) : ''); }
          else showToast(`加载失败：${s.error}`);
          if (l.ok) setLog(l.value);
          if (p.ok) setPca(p.value);
        }, [rpc, showToast]);
        useEffect(() => { void load(); }, [load]);
        useEffect(() => { if (canvasRef.current) drawScatter(canvasRef.current, pca?.points ?? []); }, [pca]);
        //：卡片随窗口变宽时 canvas 显示尺寸变化，重设内部分辨率并重绘（防拉伸/模糊）
        useEffect(() => {
          const el = canvasRef.current;
          if (!el) return;
          const ro = new ResizeObserver(() => { if (canvasRef.current) drawScatter(canvasRef.current, pca?.points ?? []); });
          ro.observe(el);
          return () => ro.disconnect();
        }, [pca]);
        const toggle = async () => {
          const next = !(st?.enabled === true);
          const r = await rpc('consistency.configure', { enabled: next });
          if (r.ok) { setSt(r.value); showToast(next ? '人格一致性已开启' : '人格一致性已关闭'); }
          else showToast(`操作失败：${r.error}`);
        };
        const saveThresholds = async () => {
          const patch = {};
          const a = parseFloat(alphaIn); if (Number.isFinite(a) && a > 0) patch.alpha = a;
          const b = parseFloat(betaIn); if (Number.isFinite(b) && b > 0) patch.beta = b;
          if (Object.keys(patch).length === 0) { showToast('请输入有效的阈值数值'); return; }
          const r = await rpc('consistency.configure', patch);
          if (r.ok) { setSt(r.value); showToast('阈值已更新（立即生效）'); }
          else showToast(`更新失败：${r.error}`);
        };
        const resetCal = async () => {
          const r = await rpc('consistency.configure', { resetCalibration: true });
          if (r.ok) { setSt(r.value); setAlphaIn(''); setBetaIn(''); showToast('已恢复自动校准（轨迹满 20 点后自动重算 α/β）'); }
          else showToast(`操作失败：${r.error}`);
        };
        const fmtN = (x) => (x == null ? '—' : (Math.round(Number(x) * 100) / 100).toString());
        const sc = st?.stats ?? {};
        return e('div', null,
          e(Card, { title: '🛡️ 人格一致性', right: e(Btn, { label: st?.enabled ? '关闭' : '开启', kind: st?.enabled ? 'danger' : 'primary', small: true, onClick: () => void toggle() }) },
            e('p', { className: 'dim' }, '对比"人格发展轨迹"防止 AI 角色偏离过大：每轮回复落库后提取人格状态向量（ollama 768 维），与轨迹最近 20 点的平均欧氏距离 = 突变梯度 G；G<α 放行 / α≤G≤β 局部重写（渲染层替换显示）/ G>β 强制刹车（存档+按进化方向重生成）。'),
            e(Stats, { items: [
              { k: '已检测', v: sc.checks ?? 0 }, { k: '放行', v: sc.pass ?? 0 }, { k: '可疑(重写)', v: sc.suspicious ?? 0 },
              { k: '拦截', v: sc.blocked ?? 0 }, { k: '航点', v: st?.waypointCount ?? 0 }, { k: '倒叙修正', v: sc.corrections ?? 0 },
            ] }),
            e('div', { className: 't2', style: { gap: 8, flexWrap: 'wrap', marginTop: 6 } },
              e(Badge, { text: `轨迹点 ${st?.turnCount ?? 0}/${st?.windowSize ?? 100}`, tone: st?.turnCount >= (st?.lastN ?? 20) ? 'good' : 'dim' }),
              e(Badge, { text: `参考点数 ${st?.lastN ?? 20}`, tone: 'dim' }),
              e(Badge, { text: `α ${fmtN(st?.alpha)}`, tone: 'warn' }),
              e(Badge, { text: `β ${fmtN(st?.beta)}`, tone: 'err' }),
              e(Badge, { text: st?.calibrated ? '已校准' : '待校准（轨迹满 20 点自动）', tone: st?.calibrated ? 'good' : 'warn' }),
              e(Badge, { text: st?.guardActive ? '护栏生效中' : '护栏待命', tone: st?.guardActive ? 'good' : 'dim' })),
            e('p', { className: 'arc-hint', style: { marginTop: 6 } }, '开关持久化重启保持；护栏=有航点或近期可疑时，对话回合自动注入一句人格一致性提示（零额外模型调用）。')),
          e(Card, { title: '🗺️ 人格轨迹（PCA 前 3 维，图上前 2 维）', right: e(Btn, { label: '↻ 刷新', small: true, onClick: () => void load() }) },
            e('canvas', { ref: canvasRef, width: 640, height: 240, className: 'arc-canvas', style: { width: '100%', height: 240, background: 'var(--arc-l1)', border: '1px solid var(--arc-bd)', borderRadius: 8 } }),
            e('p', { className: 'arc-hint', style: { marginTop: 6 } }, (pca?.points?.length ?? 0) >= 3 ? '主成分压缩的 3D 人格坐标（展示前 2 维）：点的漂移越大说明人格状态变化越大。' : '轨迹点不足 3 个，暂无法绘制（继续对话即可累积）。')),
          e(Card, { title: '🎚️ 阈值调整' },
            e('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              e('span', { className: 'k' }, 'α（放行/可疑）'),
              e('input', { className: 'arc-text', style: { width: 110 }, value: alphaIn, placeholder: '自动', onChange: (ev) => setAlphaIn(ev.target.value) }),
              e('span', { className: 'k' }, 'β（可疑/拦截）'),
              e('input', { className: 'arc-text', style: { width: 110 }, value: betaIn, placeholder: '自动', onChange: (ev) => setBetaIn(ev.target.value) }),
              e(Btn, { label: '保存阈值', kind: 'primary', small: true, onClick: () => void saveThresholds() }),
              e(Btn, { label: '恢复自动校准', small: true, onClick: () => void resetCal() })),
            e('p', { className: 'arc-hint', style: { marginTop: 6 } }, '默认自动校准：轨迹点对距离中位数 × α 系数(1.2)/β 系数(2.2)。每次进化审批通过会自动抬高 β（为沿新方向的漂移留空间，带上限保护）。')),
          e(Card, { title: '⛔ 拦截记录（严重突变，被拒绝采用的回复）' },
            (() => {
              const rejected = Array.isArray(log?.rejected) ? log.rejected : [];
              if (rejected.length === 0) return e('p', { className: 'dim' }, '暂无拦截记录。');
              return e('div', { className: 'arc-list' },
                rejected.slice().reverse().map((r) => e('div', { key: `${r.t}-${r.seq}`, className: 'arc-item' },
                  e('div', { className: 't2' },
                    e(Badge, { text: r.corrected ? '已倒叙修正' : '未修正', tone: r.corrected ? 'good' : 'err' }),
                    e('span', null, fmtTime(r.t)),
                    e('span', null, `梯度 ${r.g} > β`)),
                  e('div', { className: 't1', style: { fontSize: 12.5, color: 'var(--arc-dim)' } }, truncate(r.text, 200)))));
            })()),
          e(Card, { title: '✏️ 修订记录（可疑档：已按人格轨迹平滑过渡）' },
            (() => {
              const revisions = Array.isArray(log?.revisions) ? log.revisions : [];
              if (revisions.length === 0) return e('p', { className: 'dim' }, '暂无修订记录。');
              return e('div', { className: 'arc-list' },
                revisions.slice().reverse().map((r) => e('div', { key: `${r.t}-${r.seq}`, className: 'arc-item' },
                  e('div', { className: 't2' }, e(Badge, { text: '修订', tone: 'warn' }), e('span', null, fmtTime(r.t)), e('span', null, `梯度 ${r.g}`)),
                  e('div', { className: 't1', style: { fontSize: 12.5 } }, `原文：${truncate(r.original, 120)}`),
                  r.revised ? e('div', { className: 't1', style: { fontSize: 12.5, color: 'var(--arc-warn)' } }, `修订：${truncate(r.revised, 160)}`) : e('div', { className: 't2' }, e('span', { style: { color: 'var(--arc-faint)' } }, '修订失败（保留原文）')))));
            })()),
          e(Card, { title: '🔄 倒叙修正（进化审批通过后，用新人格重写被拦截的回复）' },
            (() => {
              const corrections = Array.isArray(log?.corrections) ? log.corrections : [];
              if (corrections.length === 0) return e('p', { className: 'dim' }, '暂无倒叙修正记录（审批进化建议后自动执行）。');
              return e('div', { className: 'arc-list' },
                corrections.slice().reverse().map((c, i) => e('div', { key: `${c.t}-${i}`, className: 'arc-item' },
                  e('div', { className: 't2' },
                    e(Badge, { text: c.status === 'done' ? '已重写' : '失败', tone: c.status === 'done' ? 'good' : 'err' }),
                    e('span', null, fmtTime(c.t)),
                    e('span', { className: 'arc-hint' }, `新方向：${truncate(c.direction, 60)}`)),
                  e('div', { className: 't1', style: { fontSize: 12.5, color: 'var(--arc-dim)' } }, `原文：${truncate(c.content, 100)}`),
                  c.rewritten ? e('div', { className: 't1', style: { fontSize: 12.5, color: 'var(--arc-good)' } }, `重写：${truncate(c.rewritten, 160)}`) : null)));
            })()),
        );
      }

      // ================= 定时任务 =================
      function PageSchedule({ rpc, showToast, askConfirm }) {
        const [tasks, setTasks] = useState([]);
        const [stats, setStats] = useState(null);
        const [busy, setBusy] = useState(false);
        const [form, setForm] = useState({ task: '', type: 'message', schedule: 'one-time', at: '', intervalMinutes: '30' });

        const load = useCallback(async () => {
          setBusy(true);
          const [l, s] = await Promise.all([rpc('schedule.list'), rpc('schedule.stats')]);
          if (l.ok) setTasks(Array.isArray(l.value?.tasks) ? l.value.tasks : []);
          if (s.ok) setStats(s.value);
          setBusy(false);
        }, [rpc]);
        useEffect(() => { void load(); }, [load]);

        const create = async () => {
          const task = form.task.trim();
          if (!task) { showToast('请输入任务内容'); return; }
          const payload = { task, type: form.type, schedule: form.schedule };
          if (form.schedule === 'interval') {
            const iv = Number(form.intervalMinutes);
            if (!Number.isFinite(iv) || iv < 1) { showToast('间隔分钟必须 ≥ 1'); return; }
            payload.intervalMinutes = iv;
          } else if (form.schedule === 'daily') {
            if (!form.at) { showToast('每天任务请选择触发时刻'); return; }
            const [hh, mm] = form.at.split(':').map(Number);
            if (Number.isFinite(hh) && Number.isFinite(mm)) {
              const d = new Date(); d.setHours(hh, mm, 0, 0);
              payload.at = d.getTime();
            }
          } else if (form.schedule === 'one-time') {
            //：一次性任务必须选到期时间，否则会立即触发（服务端把无 at 当作 now）
            if (!form.at) { showToast('一次性任务请选择到期时间'); return; }
            const t = new Date(form.at).getTime();
            if (!Number.isNaN(t)) payload.at = t;
          }
          const r = await rpc('schedule.create', payload);
          if (r.ok) { showToast('已创建'); setForm({ task: '', type: 'message', schedule: 'one-time', at: '', intervalMinutes: '30' }); void load(); }
          else showToast(`创建失败：${r.error}`);
        };
        const cancel = (t) => {
          askConfirm(`取消任务「${truncate(t.task, 50)}」？`, async () => {
            const r = await rpc('schedule.cancel', { id: t.id });
            if (r.ok) { showToast(r.value?.cancelled ? '已取消' : '取消失败（状态已变更）'); void load(); } else showToast(`取消失败：${r.error}`);
          });
        };

        const byStatus = stats?.byStatus ?? {};
        const taskTone = (s) => STATUS_TONE[s] ?? 'dim';
        const taskLabel = { pending: '待执行', fired: '已执行', cancelled: '已取消', missed: '错过', failed: '失败' };
        return e('div', null,
          e(Stats, { items: [
            { k: '待执行', v: byStatus.pending ?? 0 },
            { k: '已执行', v: byStatus.fired ?? 0 },
            { k: '已取消', v: byStatus.cancelled ?? 0 },
            { k: '错过', v: byStatus.missed ?? 0 },
            { k: '失败', v: byStatus.failed ?? 0 },
          ] }),
          e(Card, { title: '➕ 新建定时任务', right: e(Btn, { label: '创建', kind: 'primary', small: true, onClick: () => void create() }) },
            e('input', { className: 'arc-text', placeholder: '任务内容（到点提醒/干活）…', value: form.task, onChange: (ev) => setForm({ ...form, task: ev.target.value }) }),
            e('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
              e('select', { className: 'arc-sel', style: { width: 130, margin: 0 }, value: form.type, onChange: (ev) => setForm({ ...form, type: ev.target.value }) },
                e('option', { value: 'message' }, '提醒（message）'),
                e('option', { value: 'work' }, '干活（work）')),
              e('select', { className: 'arc-sel', style: { width: 140, margin: 0 }, value: form.schedule, onChange: (ev) => setForm({ ...form, schedule: ev.target.value }) },
                e('option', { value: 'one-time' }, '一次性'),
                e('option', { value: 'daily' }, '每天'),
                e('option', { value: 'interval' }, '每 N 分钟')),
              form.schedule === 'interval'
                ? e('input', { className: 'arc-text', style: { width: 100, margin: 0 }, placeholder: '分钟', value: form.intervalMinutes, onChange: (ev) => setForm({ ...form, intervalMinutes: ev.target.value }) })
                : form.schedule === 'daily'
                  ? e('input', { className: 'arc-text', style: { width: 130, margin: 0 }, type: 'time', value: form.at, onChange: (ev) => setForm({ ...form, at: ev.target.value }) })
                  : e('input', { className: 'arc-text', style: { width: 200, margin: 0 }, type: 'datetime-local', value: form.at, onChange: (ev) => setForm({ ...form, at: ev.target.value }) }),
            ),
            e('p', { className: 'arc-hint' }, 'message = 到点发主动消息提醒；work = 到点生成待办记忆并触发一轮思考处理。')),
          e(Card, { title: '📅 任务列表', right: e(Btn, { label: '↻ 刷新', small: true, onClick: () => void load() }) },
            tasks.length === 0 ? e('p', { className: 'dim' }, '暂无任务') :
              e('div', { className: 'arc-list' },
                tasks.map((t) => e('div', { key: t.id, className: 'arc-item' },
                  e('div', { className: 't1' }, t.task),
                  e('div', { className: 't2' },
                    e(Badge, { text: taskLabel[t.status] ?? t.status, tone: taskTone(t.status) }),
                    e('span', null, t.type === 'work' ? '干活' : '提醒'),
                    e('span', null, t.schedule === 'interval' ? `每 ${t.intervalMinutes} 分钟` : t.schedule === 'daily' ? `每天 ${fmtTime(t.dueAt).slice(6)}` : '一次性'),
                    e('span', null, t.schedule === 'interval' ? `下次 ${fmtTime(t.dueAt)}` : `到期 ${fmtTime(t.dueAt)}`),
                    t.firedAt ? e('span', null, `已触发 ${fmtTime(t.firedAt)}`) : null,
                    t.missedNote ? e('span', { style: { color: 'var(--arc-err)' } }, t.missedNote) : null),
                  t.status === 'pending' && e('div', { className: 'ops' },
                    e(Btn, { label: '取消', kind: 'danger', small: true, onClick: () => void cancel(t) })))))),
        );
      }

      // ================= 通知 =================
      function PageNotify({ rpc, showToast, askConfirm }) {
        const [items, setItems] = useState([]);
        const [stats, setStats] = useState(null);
        const [busy, setBusy] = useState(false);

        const load = useCallback(async () => {
          setBusy(true);
          const [l, s] = await Promise.all([rpc('notify.view', { limit: 60 }), rpc('notify.stats')]);
          if (l.ok) setItems(Array.isArray(l.value?.notifications) ? l.value.notifications : []);
          if (s.ok) setStats(s.value);
          setBusy(false);
        }, [rpc]);
        useEffect(() => { void load(); }, [load]);

        const markAll = async () => {
          const r = await rpc('notify.markRead', {});
          if (r.ok) { showToast(`已标记 ${r.value?.marked ?? 0} 条已读`); void load(); } else showToast(`失败：${r.error}`);
        };
        const clearRead = async () => {
          askConfirm('清空全部已读通知？（未读保留）', async () => {
            const r = await rpc('notify.clearRead');
            if (r.ok) { showToast(`已清空 ${r.value?.removed ?? 0} 条已读`); void load(); } else showToast(`失败：${r.error}`);
          });
        };
        const markOne = async (id) => {
          const r = await rpc('notify.markRead', { id });
          if (r.ok) { void load(); } else showToast(`失败：${r.error}`);
        };
        return e('div', null,
          e(Stats, { items: [
            { k: '通知总数', v: stats?.total ?? 0 },
            { k: '未读', v: stats?.unread ?? 0 },
            { k: '限频', v: stats?.minIntervalMs ? `${Math.round(stats.minIntervalMs / 1000)}s` : '—' },
          ] }),
          e(Card, { title: '🔔 主动消息通知', right: e('div', { style: { display: 'flex', gap: 6 } },
            e(Btn, { label: '↻ 刷新', small: true, onClick: () => void load() }),
            e(Btn, { label: '清空已读', small: true, onClick: () => void clearRead() }),
            e(Btn, { label: '全部已读', kind: 'primary', small: true, onClick: () => void markAll() })) },
            items.length === 0 ? e('p', { className: 'dim' }, '暂无通知（自循环主动发言、定时提醒会送达这里与总会话）') :
              e('div', { className: 'arc-list' },
                items.map((n) => e('div', { key: n.id, className: 'arc-item', style: n.read ? {} : { background: 'var(--arc-l2)' } },
                  e('div', { className: 't1' }, n.content),
                  e('div', { className: 't2' },
                    n.read ? e(Badge, { text: '已读', tone: 'dim' }) : e(Badge, { text: '未读', tone: 'warn' }),
                    e('span', null, fmtFull(n.at)),
                    e('span', null, `来源 ${n.source ?? 'system'}`),
                    !n.read && e('div', { className: 'ops', style: { marginTop: 4 } },
                      e(Btn, { label: '标为已读', small: true, onClick: () => void markOne(n.id) }))))))),
        );
      }

      // ================= 工具与技能 =================
      function PageTools({ rpc, showToast }) {
        const [tab, setTab] = useState('tools');
        const [tools, setTools] = useState([]);
        const [skills, setSkills] = useState([]);
        const [busy, setBusy] = useState(false);
        const [query, setQuery] = useState('');

        const load = useCallback(async () => {
          setBusy(true);
          const [t, s] = await Promise.all([rpc('tools.list'), rpc('skills.list')]);
          if (t.ok) setTools(Array.isArray(t.value?.tools) ? t.value.tools : []); else showToast(`工具加载失败：${t.error}`);
          if (s.ok) setSkills(Array.isArray(s.value?.skills) ? s.value.skills : []); else showToast(`技能加载失败：${s.error}`);
          setBusy(false);
        }, [rpc, showToast]);
        useEffect(() => { void load(); }, [load]);

        const q = query.trim().toLowerCase();
        //  修复：description 可能缺失（服务端 summary 恒给但防护与渲染层 '—' 兜底一致）
        const ftools = q ? tools.filter((x) => (x.name || '').toLowerCase().includes(q) || (x.description || '').toLowerCase().includes(q)) : tools;
        const fskills = q ? skills.filter((x) => (x.name || '').toLowerCase().includes(q) || (x.description || '').toLowerCase().includes(q) || (x.whenToUse || '').toLowerCase().includes(q)) : skills;

        return e('div', null,
          e(Stats, { items: [
            { k: '工具数', v: tools.length },
            { k: '技能数', v: skills.length },
            { k: '视角', v: '主会话 agent' },
          ] }),
          e('div', { className: 'arc-tabs' },
            [['tools', `工具 (${tools.length})`], ['skills', `技能 (${skills.length})`]].map(([id, label]) =>
              e('button', { key: id, className: `arc-tab${tab === id ? ' on' : ''}`, onClick: () => setTab(id) }, label))),
          e(Card, { title: tab === 'tools' ? '🛠️ 工具清单（主会话 agent 可用）' : '📘 技能清单（Skill）',
            right: e('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
              e('input', { className: 'arc-text', style: { width: 180, margin: 0 }, placeholder: '过滤…', value: query, onChange: (ev) => setQuery(ev.target.value) }),
              e(Btn, { label: busy ? '刷新中…' : '↻ 刷新', small: true, onClick: () => void load() })) },
            tab === 'tools'
              ? (ftools.length === 0 ? e('p', { className: 'dim' }, '无工具') :
                  e('div', { className: 'arc-list' },
                    ftools.map((t) => e('div', { key: t.name, className: 'arc-item' },
                      e('div', { className: 't1', style: { fontFamily: 'var(--arc-mono)', fontSize: 12.5 } }, t.name),
                      e('div', { className: 'arc-note', style: { marginTop: 3 } }, t.description || '—')))))
              : (fskills.length === 0 ? e('p', { className: 'dim' }, '无技能') :
                  e('div', { className: 'arc-list' },
                    fskills.map((s) => e('div', { key: s.name, className: 'arc-item' },
                      e('div', { className: 't1', style: { fontFamily: 'var(--arc-mono)', fontSize: 12.5 } }, s.name),
                      e('div', { className: 'arc-note', style: { marginTop: 3 } }, s.description || '—'),
                      s.whenToUse ? e('div', { className: 'arc-note', style: { marginTop: 3 } }, `适用：${s.whenToUse}`) : null,
                      e('div', { className: 't2' },
                        e(Badge, { text: `来源 ${s.source || '?'}`, tone: 'brand' }),
                        e('span', null, `provider ${s.provider || '?'}`))))))),
        );
      }

      // ================= 模型提供商 =================
      function PageModels({ rpc, showToast }) {
        const [data, setData] = useState(null);
        const [busy, setBusy] = useState(false);
        const [dkKey, setDkKey] = useState('');
        const [form, setForm] = useState({ id: '', name: '', baseURL: '', apiKey: '', model: '', enabled: true });
        const [editingIdx, setEditingIdx] = useState(-1);
        const [testRes, setTestRes] = useState('');

        // 测试连接（避免配置错误后自循环静默瘫痪）
        const testProvider = async () => {
          if (!form.baseURL.trim() || !form.model.trim()) { setTestRes('请先填写接口地址与模型名'); return; }
          setTestRes('测试中…');
          const r = await rpc('models.testProvider', { baseURL: form.baseURL.trim(), model: form.model.trim(), apiKey: form.apiKey.trim() });
          if (r.ok) setTestRes(r.value?.ok ? `✅ ${r.value.note}` : `❌ ${r.value.error || '连接失败'}`);
          else setTestRes(`❌ ${r.error}`);
        };

        const load = useCallback(async () => {
          setBusy(true);
          const r = await rpc('models.get');
          if (r.ok) setData(r.value); else showToast(`加载失败：${r.error}`);
          setBusy(false);
        }, [rpc, showToast]);
        useEffect(() => { void load(); }, [load]);

        const saveDeepSeek = async () => {
          const key = dkKey.trim();
          if (!key) { showToast('请输入 API 密钥'); return; }
          const r = await rpc('models.setDeepSeekKey', { key });
          if (r.ok) { showToast('DeepSeek 密钥已保存（对话/循环/识图生效）'); setDkKey(''); void load(); }
          else showToast(`保存失败：${r.error}`);
        };
        const saveProviders = async () => {
          const list = (data?.providers ?? []).map((p) => ({ ...p, enabled: p.enabled !== false }));
          if (form.name.trim() && form.baseURL.trim() && form.model.trim()) {
            if (editingIdx >= 0 && editingIdx < list.length) {
              list[editingIdx] = { ...list[editingIdx], ...form, apiKey: form.apiKey || list[editingIdx].apiKey };
            } else {
              list.push({ id: `p${Date.now()}`, ...form });
            }
          }
          const r = await rpc('models.setProviders', { providers: list });
          if (r.ok) { showToast('提供商列表已保存（自循环将使用启用的自定义提供商）'); setForm({ id: '', name: '', baseURL: '', apiKey: '', model: '', enabled: true }); setEditingIdx(-1); void load(); }
          else showToast(`保存失败：${r.error}`);
        };
        const removeProvider = async (idx) => {
          const list = (data?.providers ?? []).filter((_, i) => i !== idx);
          const r = await rpc('models.setProviders', { providers: list });
          if (r.ok) { showToast('已删除'); void load(); } else showToast(`删除失败：${r.error}`);
        };
        const toggleProvider = async (idx) => {
          const list = (data?.providers ?? []).map((p, i) => (i === idx ? { ...p, enabled: !p.enabled } : p));
          const r = await rpc('models.setProviders', { providers: list });
          if (r.ok) void load();
        };
        const editProvider = (idx) => {
          const p = (data?.providers ?? [])[idx];
          if (!p) return;
          setEditingIdx(idx);
          setForm({ id: p.id, name: p.name, baseURL: p.baseURL, apiKey: '', model: p.model, enabled: p.enabled !== false });
        };

        const providers = data?.providers ?? [];
        return e('div', null,
          e(Stats, { items: [
            { k: '自定义提供商', v: providers.length },
            { k: '已启用', v: providers.filter((p) => p.enabled !== false).length },
            { k: 'DeepSeek 密钥', v: data?.deepseekConfigured ? '已配置' : '未配置' },
          ] }),
          //：未配置模型提供商横幅（与发送拦截同口径：DeepSeek 密钥或启用中的自定义提供商任一即可）
          (data && !data.deepseekConfigured && !providers.some((p) => p.enabled !== false && p.apiKeySet && p.baseURL && p.model))
            ? e('div', { className: 'arc-banner-warn' }, '⚠️ 未配置模型提供商：对话消息将不会发送。请在上方填入 DeepSeek API 密钥并保存，或添加并启用一个自定义提供商。')
            : null,
          e(Card, { title: '🔵 DeepSeek 官方（对话与自循环默认）', right: e(Btn, { label: '保存密钥', kind: 'primary', small: true, onClick: () => void saveDeepSeek() }) },
            e(Row, { k: '接口地址', v: data?.deepseekBaseURL ?? 'https://api.deepseek.com/v1', mono: true }),
            e(Row, { k: '默认模型', v: data?.deepseekModel ?? 'deepseek-v4-flash', mono: true }),
            e(Row, { k: 'API 密钥', v: data?.deepseekConfigured ? '✓ 已配置（保存在项目内 credentials.yaml）' : '未配置' }),
            e('input', { className: 'arc-text', placeholder: '输入 DeepSeek API 密钥（保存后对话/循环/识图生效）…', type: 'password', value: dkKey, onChange: (ev) => setDkKey(ev.target.value) }),
            e('p', { className: 'arc-hint' }, '密钥经 credentials 服务写入项目内 dsh/data/credentials.yaml；为空则不修改。')),
          e(Card, { title: '🔧 自定义 OpenAI 兼容提供商（自循环使用）', right: e(Btn, { label: busy ? '刷新中…' : '↻ 刷新', small: true, onClick: () => void load() }) },
            providers.length === 0 ? e('p', { className: 'dim' }, '暂无自定义提供商（可添加任意 OpenAI 兼容端点：本地 Ollama/vLLM/中转站等）') :
              e('div', { className: 'arc-list' },
                providers.map((p, i) => e('div', { key: p.id, className: 'arc-item' },
                  e('div', { className: 't1' }, p.name, ' ', e(Badge, { text: p.enabled !== false ? '启用' : '停用', tone: p.enabled !== false ? 'good' : 'dim' })),
                  e('div', { className: 't2' },
                    e('span', { className: 'arc-tag' }, p.baseURL),
                    e('span', null, `模型 ${p.model}`),
                    e('span', null, p.apiKeySet ? '密钥已配' : '无密钥')),
                  e('div', { className: 'ops' },
                    e(Btn, { label: p.enabled !== false ? '停用' : '启用', small: true, onClick: () => void toggleProvider(i) }),
                    e(Btn, { label: '编辑', small: true, onClick: () => editProvider(i) }),
                    e(Btn, { label: '删除', kind: 'danger', small: true, onClick: () => void removeProvider(i) }))))),
            e('div', { style: { marginTop: 12 } },
              e('div', { className: 'arc-hint', style: { marginBottom: 4 } }, editingIdx >= 0 ? '编辑提供商' : '添加提供商'),
              e('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
                e('input', { className: 'arc-text', placeholder: '名称（如 本地 Ollama）', value: form.name, onChange: (ev) => setForm({ ...form, name: ev.target.value }) }),
                e('input', { className: 'arc-text', placeholder: '模型名（如 llama3）', value: form.model, onChange: (ev) => setForm({ ...form, model: ev.target.value }) })),
              e('input', { className: 'arc-text', placeholder: '接口地址（如 http://127.0.0.1:11434/v1）', value: form.baseURL, onChange: (ev) => setForm({ ...form, baseURL: ev.target.value }) }),
              e('input', { className: 'arc-text', placeholder: 'API 密钥（编辑时留空保留原值）', type: 'password', value: form.apiKey, onChange: (ev) => setForm({ ...form, apiKey: ev.target.value }) }),
              e('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                e(Btn, { label: editingIdx >= 0 ? '保存修改' : '添加', kind: 'primary', small: true, onClick: () => void saveProviders() }),
                e(Btn, { label: '测试连接', small: true, onClick: () => void testProvider() }),
                editingIdx >= 0 && e(Btn, { label: '取消编辑', small: true, onClick: () => { setEditingIdx(-1); setForm({ id: '', name: '', baseURL: '', apiKey: '', model: '', enabled: true }); setTestRes(''); } }),
                e('label', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--arc-dim)' } },
                  e('input', { type: 'checkbox', checked: form.enabled, onChange: (ev) => setForm({ ...form, enabled: ev.target.checked }) }), '启用'))),
            testRes ? e('p', { className: 'arc-note', style: { marginTop: 8, whiteSpace: 'pre-wrap' } }, testRes) : null,
            e('p', { className: 'arc-hint' }, '自循环思考将使用第一个启用的自定义提供商（OpenAI 兼容 /chat/completions）；不配置则用 DeepSeek 官方。')),
        );
      }

      // ================= 识图（测试 + 提供商配置） =================
      function PageVision({ rpc, showToast }) {
        const [tab, setTab] = useState('test');
        const [path, setPath] = useState('');
        const [res, setRes] = useState('');
        const [busy, setBusy] = useState(false);
        const [cfg, setCfg] = useState(null); // {baseURL, model, apiKeySet, apiKeyEnv}
        const [cBase, setCBase] = useState('');
        const [cModel, setCModel] = useState('');
        const [cKey, setCKey] = useState('');

        const loadCfg = useCallback(async () => {
          const r = await rpc('vision.config.get');
          if (r.ok) {
            setCfg(r.value);
            setCBase(r.value?.baseURL ?? '');
            setCModel(r.value?.model ?? '');
          } else showToast(`配置读取失败：${r.error}`);
        }, [rpc, showToast]);
        useEffect(() => { if (tab === 'config') void loadCfg(); }, [tab, loadCfg]);

        const run = async () => {
          if (!path.trim()) { setRes('请输入图片路径或 URL'); return; }
          setBusy(true);
          setRes('识别中…');
          const r = await rpc('vision.test', { path: path.trim() });
          setBusy(false);
          setRes(r.ok ? `✅ ${r.value?.text ?? ''}` : `❌ ${r.error}`);
        };
        const saveCfg = async () => {
          const patch = { baseURL: cBase.trim(), model: cModel.trim() };
          if (cKey.trim()) patch.apiKey = cKey.trim();
          const r = await rpc('vision.config.set', patch);
          if (r.ok) { showToast('识图提供商配置已保存（立即生效）'); setCKey(''); void loadCfg(); }
          else showToast(`保存失败：${r.error}`);
        };
        return e('div', null,
          e('div', { className: 'arc-tabs' },
            [['test', '识图测试'], ['config', '提供商配置']].map(([id, label]) =>
              e('button', { key: id, className: `arc-tab${tab === id ? ' on' : ''}`, onClick: () => setTab(id) }, label))),
          tab === 'test' && e(Card, { title: '🖼️ 识图（视觉模型）', right: e(Btn, { label: busy ? '识别中…' : '识别', kind: 'primary', small: true, onClick: () => void run() }) },
            e('p', { className: 'dim' }, '输入本地图片路径或 http(s) URL，Host 端调用视觉模型识别。'),
            e('input', { className: 'arc-text', placeholder: 'C:/path/to/img.png 或 https://…', value: path, onChange: (ev) => setPath(ev.target.value), onKeyDown: (ev) => { if (ev.key === 'Enter') void run(); } }),
            res ? e('p', { className: 'arc-note', style: { whiteSpace: 'pre-wrap', marginTop: 10 } }, res) : null,
            e('p', { className: 'arc-hint' }, '与对话中的 describe_image 工具同源；识别端点见「提供商配置」tab。')),
          tab === 'config' && e(Card, { title: '🎨 识图模型提供商', right: e(Btn, { label: '保存配置', kind: 'primary', small: true, onClick: () => void saveCfg() }) },
            e('p', { className: 'dim' }, '配置识别图片所用的视觉模型端点（写入 describe-image 的运行时配置，保存后立即生效）。'),
            e(Row, { k: '当前密钥', v: cfg?.apiKeySet ? `✓ 已配置${cfg.apiKeyEnv ? `（${cfg.apiKeyEnv}）` : ''}` : '未配置' }),
            e('input', { className: 'arc-text', placeholder: '接口地址（如 https://api.deepseek.com/v1）', value: cBase, onChange: (ev) => setCBase(ev.target.value) }),
            e('input', { className: 'arc-text', placeholder: '视觉模型（如 deepseek-v4-flash-vision-exp）', value: cModel, onChange: (ev) => setCModel(ev.target.value) }),
            e('input', { className: 'arc-text', placeholder: 'API 密钥（留空保留原值）', type: 'password', value: cKey, onChange: (ev) => setCKey(ev.target.value) }),
            e('p', { className: 'arc-hint' }, '密钥只保存不回显；清空某项则不修改该项。')),
        );
      }

      // ================= 每日简报 =================
      function PageReport({ rpc, showToast }) {
        const [busy, setBusy] = useState(false);
        const [report, setReport] = useState(null); // {brief, counts, generatedAt}
        const generate = async () => {
          setBusy(true);
          setReport(null);
          showToast('正在汇总最近 24 小时并生成简报…');
          const r = await rpc('report.daily');
          setBusy(false);
          if (r.ok) setReport(r.value);
          else showToast(`生成失败：${r.error}`);
        };
        return e('div', null,
          e(Card, { title: '📋 每日简报', right: e(Btn, { label: busy ? '生成中…' : '生成最近 24 小时简报', kind: 'primary', small: true, onClick: () => void generate(), disabled: busy }) },
            e('p', { className: 'dim' }, '汇总最近 24 小时的 AI 自主活动（自循环决策 / 主动发言 / 记忆变化 / 通知 / 定时任务），由模型生成带时间戳的中文简报。')),
          report && e(Card, { title: `📝 ${fmtFull(report.generatedAt)} 简报`, right: e('div', { className: 't2', style: { gap: 8 } },
            e(Badge, { text: `记忆 ${report.counts?.memories ?? 0}`, tone: 'brand' }),
            e(Badge, { text: `决策 ${report.counts?.decisions ?? 0}`, tone: 'brand' }),
            e(Badge, { text: `通知 ${report.counts?.notifications ?? 0}`, tone: 'brand' }),
            e(Badge, { text: `任务 ${report.counts?.tasks ?? 0}`, tone: 'brand' })) },
            e('div', { className: 'arc-note', style: { whiteSpace: 'pre-wrap', lineHeight: 1.8 } }, report.brief)),
          !report && !busy && e('p', { className: 'arc-hint' }, '点击上方按钮生成。生成会调用一次模型（消耗少量 token）。'),
        );
      }

      // ===== 记录面板 Dock（）：底部常驻可收起，💬提示词 / ⚠️报错 双页签 =====
      // 数据源：modules/ledger 宿主五路采集（logger/console/fetch/ctx.llm/进程级 + RPC 转发 + 浏览器上报），
      // 经 /archive-ledger RPC 读取；模块色标与各页面/模块一一对应，时间标注精确到秒。
      const LEDGER_META = {
        loop: { label: '思维循环', color: '#5686fe' },
        evolution: { label: '自进化', color: '#4ed17e' },
        consistency: { label: '人格一致性', color: '#a78bfa' },
        subconscious: { label: '潜意识', color: '#f472b6' },
        control: { label: '总控', color: '#f7ad31' },
        memory: { label: '记忆', color: '#22d3ee' },
        clock: { label: '时钟', color: '#fbbf24' },
        notify: { label: '通知', color: '#fb7185' },
        schedule: { label: '定时任务', color: '#fb923c' },
        persona: { label: '人格', color: '#c084fc' },
        'describe-image': { label: '识图', color: '#facc15' },
        core: { label: '主会话/核心', color: '#60a5fa' },
        web: { label: '浏览器', color: '#94a3b8' },
      };
      function ledMeta(module) { const m = LEDGER_META[module]; return m || { label: module || '其他', color: '#94a3b8' }; }
      const LED_LEVEL_TONE = { warn: '#f7ad31', error: '#f87171', uncaught: '#c084fc', unhandled: '#c084fc', rpc: '#f87171', client: '#f87171' };
      async function copyText(txt) {
        try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(txt); return true; } } catch { /* 回退 execCommand */ }
        try {
          const ta = document.createElement('textarea');
          ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.focus(); ta.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(ta);
          return ok;
        } catch { return false; }
      }
      function promptTextOf(p) {
        const s = String(p?.system ?? '').trim();
        const u = String(p?.user ?? '').trim();
        return (s ? `【系统提示】\n${s}\n` : '') + (u ? `【用户/场景】\n${u}` : '');
      }
      //  性能修复：React.memo 包裹。配合下方增量拉取（既有 item 的引用保持不变），
      // 轮询到"无新增"或"只追加少量"时，已渲染的行零重渲染。
      const LedPromptRow = React.memo(function LedPromptRow({ item, showToast }) {
        const [open, setOpen] = useState(false);
        const meta = ledMeta(item.module);
        const status = item.status || 'sent';
        const stColor = status === 'ok' ? 'var(--arc-good)' : (status === 'error' ? 'var(--arc-err)' : (status.startsWith('http-') ? 'var(--arc-warn)' : 'var(--arc-faint)'));
        const text = promptTextOf(item);
        return e('div', { className: 'arc-led' },
          e('div', { className: 'arc-led-h' },
            e('span', { className: 'arc-led-chip', style: { color: meta.color, border: `1px solid ${meta.color}66`, background: `${meta.color}1a` } }, meta.label),
            e('span', { className: 'arc-led-time' }, fmtFull(item.t)),
            item.model ? e('span', { className: 'arc-led-model', title: item.model }, item.model) : null,
            e('span', { className: 'arc-led-status', style: { color: stColor } }, status === 'ok' ? '✓ 成功' : status === 'error' ? '✕ 失败' : status.startsWith('http-') ? status : '→ 已发送'),
            e('span', { className: 'arc-led-msg', title: text.slice(0, 800) }, text ? text.slice(0, 160) : '(空内容)'),
            e('span', { className: 'arc-led-ops' },
              e('button', { className: 'arc-dock-btn', title: '复制完整提示词（含系统提示）', onClick: (ev) => { ev.stopPropagation(); void copyText(text || '(空)').then((ok) => showToast(ok ? '提示词已复制' : '复制失败')); } }, '复制'),
              e('button', { className: 'arc-dock-btn', title: open ? '收起' : '展开全文', onClick: () => setOpen(!open) }, open ? '收起' : '展开'))),
          open ? e('div', { className: 'arc-led-exp' }, text || '(空内容)') : null);
      });
      const LedErrorRow = React.memo(function LedErrorRow({ item, showToast }) {
        const [open, setOpen] = useState(false);
        const meta = ledMeta(item.module);
        const tone = LED_LEVEL_TONE[item.level] || '#f87171';
        const full = `【${meta.label} · ${fmtFull(item.t)}】\n${item.message || ''}${item.stack ? `\n\n--- 堆栈 ---\n${item.stack}` : ''}`;
        return e('div', { className: 'arc-led' },
          e('div', { className: 'arc-led-h' },
            e('span', { className: 'arc-led-chip', style: { color: meta.color, border: `1px solid ${meta.color}66`, background: `${meta.color}1a` } }, meta.label),
            e('span', { className: 'arc-led-time' }, fmtFull(item.t)),
            e('span', { className: 'arc-led-status', style: { color: tone, fontWeight: 600 } }, `[${item.level || 'error'}]`),
            e('span', { className: 'arc-led-msg', title: item.message }, item.message || '(无消息)'),
            e('span', { className: 'arc-led-ops' },
              e('button', { className: 'arc-dock-btn', title: '复制完整报错（含堆栈），可直接粘贴询问', onClick: (ev) => { ev.stopPropagation(); void copyText(full).then((ok) => showToast(ok ? '报错已复制' : '复制失败')); } }, '复制'),
              e('button', { className: 'arc-dock-btn', title: open ? '收起' : '展开堆栈', onClick: () => setOpen(!open) }, open ? '收起' : '展开'))),
          open && item.stack ? e('div', { className: 'arc-led-exp' }, item.stack) : null);
      });
      function LedgerDock({ showToast }) {
        const [open, setOpen] = useState(false);
        const [tab, setTab] = useState('prompts');
        const [prompts, setPrompts] = useState([]);
        const [errors, setErrors] = useState([]);
        const [counts, setCounts] = useState({ prompts: 0, errors: 0 });
        const [busy, setBusy] = useState(false);
        const [confirmClear, setConfirmClear] = useState(false);
        //：增量游标（每个页签独立）。null = 尚无基线 → 首次全量拉取。
        const sinceRef = useRef({ prompts: null, errors: null });
        const listRef = useRef(null);
        const nearBottomRef = useRef(true);
        // 展开高度写进 .arc-app 的 --arc-dock-h：toast 等 fixed 浮层上移避让，聊天/页面内容区由 flex 自动收缩
        useEffect(() => {
          const appEl = typeof document !== 'undefined' ? document.querySelector('.arc-app') : null;
          if (!appEl) return undefined;
          const h = open ? Math.round(Math.min(window.innerHeight * 0.4, 320) + 36) : 36;
          appEl.style.setProperty('--arc-dock-h', `${h}px`);
          return () => { try { appEl.style.setProperty('--arc-dock-h', '36px'); } catch { /* ignore */ } };
        }, [open]);
        const onListScroll = () => {
          const el = listRef.current;
          if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        };
        const loadStats = useCallback(async () => {
          const r = await ledRpc('stats', {});
          if (r.ok && r.value) {
            // 无变化守卫：计数未变时返回同一个对象引用，React 直接跳过本次重渲染
            const np = r.value.prompts ?? 0;
            const ne = r.value.errors ?? 0;
            setCounts((prev) => (prev.prompts === np && prev.errors === ne) ? prev : { prompts: np, errors: ne });
          }
        }, []);
        //  性能修复（本次控制台卡顿的根因）：原实现每 2.5s 全量拉取尾部 100 条
        // （实测 599KB/次，单条最大 9.4KB）并整体替换数组 → 100 行每轮都拿到全新对象，memo 无从生效，
        // 且每行重算 promptTextOf（对最多 9000 字做 trim+拼接）与 800 字 title，主线程每轮被占用
        // 数十毫秒，表现为整个控制台"打字卡、点选卡"。
        // 现改为按 seq 增量续拉：无新增时一个 state 都不碰；有新增时只追加，旧 item 引用保持不变，
        // 配合行组件的 React.memo 使已渲染行零重渲染。
        // 兜底（保留"断线后能补齐"语义）：首次(since=null)、服务端重启(next 回退)、
        // 环形挤出导致断档(since < oldest-1) → 一律回退全量替换。
        const loadLists = useCallback(async () => {
          setBusy(true);
          try {
            const op = tab === 'prompts' ? 'prompts.list' : 'errors.list';
            const since = sinceRef.current[tab] ?? null;
            const r = await ledRpc(op, since === null ? { limit: LED_PAGE } : { limit: LED_PAGE, since });
            if (r.ok && r.value) {
              const items = Array.isArray(r.value.items) ? r.value.items : [];
              const next = typeof r.value.next === 'number' ? r.value.next : null;
              const oldest = typeof r.value.oldest === 'number' ? r.value.oldest : null;
              const full = since === null || next === null
                || next < since
                || (oldest !== null && since < oldest - 1);
              if (full) {
                if (tab === 'prompts') setPrompts(items); else setErrors(items);
              } else if (items.length > 0) {
                const merge = (prev) => prev.concat(items).slice(-LED_PAGE);
                if (tab === 'prompts') setPrompts(merge); else setErrors(merge);
              }
              if (next !== null) sinceRef.current[tab] = next;
            }
            await loadStats();
          } catch { /* 单次刷新失败不阻断 */ }
          finally { setBusy(false); }
        }, [tab, loadStats]);
        // 展开：立即刷新 + 2.5s 轮询（贴底时自动滚到最新）；收起：8s 只刷计数徽标
        useEffect(() => {
          if (!open) return undefined;
          void loadLists();
          const iv = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void loadLists(); }, 2500);
          return () => clearInterval(iv);
        }, [open, loadLists]);
        useEffect(() => {
          if (open) return undefined;
          void loadStats();
          const iv = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void loadStats(); }, 8000);
          return () => clearInterval(iv);
        }, [open, loadStats]);
        useEffect(() => {
          if (nearBottomRef.current) {
            const el = listRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }
        });
        const doClear = async () => {
          const op = tab === 'prompts' ? 'prompts.clear' : 'errors.clear';
          const r = await ledRpc(op, {});
          if (r.ok) {
            setConfirmClear(false);
            if (tab === 'prompts') setPrompts([]); else setErrors([]);
            sinceRef.current[tab] = null; //：清空后重置游标，下一轮走全量基线
            void loadStats();
            showToast(`已清空${tab === 'prompts' ? '提示词' : '报错'}记录（文件与内存）`);
          } else showToast(`清空失败：${r.error}`);
        };
        const items = tab === 'prompts' ? prompts : errors;
        return e('div', { className: 'arc-dock' },
          e('div', { className: 'arc-dock-bar' },
            e('span', { style: { fontWeight: 700, color: 'var(--arc-tx)', fontSize: 12, whiteSpace: 'nowrap' } }, '📡 记录'),
            e('button', { className: `arc-dock-tab${tab === 'prompts' ? ' on' : ''}`, title: '每次向 LLM 发送的提示词（时间/来源模块标注）', onClick: () => setTab('prompts') },
              '💬 提示词', e('span', { className: 'n' }, String(counts.prompts ?? 0))),
            e('button', { className: `arc-dock-tab${tab === 'errors' ? ' on' : ''}`, title: '全部报错统计（时间/来源模块/级别/堆栈）', onClick: () => setTab('errors') },
              '⚠️ 报错', e('span', { className: 'n' }, String(counts.errors ?? 0))),
            e('span', { style: { marginLeft: 6, color: 'var(--arc-faint)', fontSize: 11, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              open ? (busy ? '刷新中…' : '') : '任何模块调用 LLM 或报错都会实时记录于此'),
            confirmClear
              ? e('button', { className: 'arc-dock-btn danger', style: { color: 'var(--arc-err)', fontWeight: 700 }, title: '再点一次确认清空（鼠标移开取消）', onMouseLeave: () => setConfirmClear(false), onClick: () => void doClear() }, '确认清空？')
              : e('button', { className: 'arc-dock-btn danger', title: '清空当前页签全部记录', onClick: () => setConfirmClear(true) }, '清空'),
            e('button', { className: 'arc-dock-btn', title: open ? '收起面板' : '展开面板（展开后下方内容区自动收缩）', onClick: () => setOpen(!open) }, open ? '▾ 收起' : '▴ 展开'),
          ),
          open ? e('div', { className: 'arc-dock-panel' },
            e('div', { className: 'arc-dock-list', ref: listRef, onScroll: onListScroll },
              items.length === 0
                ? e('div', { className: 'arc-dock-empty' },
                    tab === 'prompts'
                      ? '暂无提示词记录 —— 触发一次模型调用（聊天 / 思维循环 / 自进化 / 识图等）后这里会出现'
                      : '暂无报错记录 —— 一切正常 🎉')
                : (tab === 'prompts'
                    ? prompts.map((p) => e(LedPromptRow, { key: p.id, item: p, showToast }))
                    : errors.map((x) => e(LedErrorRow, { key: x.id, item: x, showToast }))),
            ),
          ) : null,
        );
      }

      // ===== 注册：整体替换 root（priority -100 shadow 出厂 z5） =====
      slots.inject('root', () => slots.register({ name: 'root', id: 'archive-ui-root', priority: -100 }, () => e(App)));
      try { if (typeof document !== 'undefined' && document.body) document.body.setAttribute('data-arc-ui', 'ready'); } catch { /* ignore */ }
      // 原生设置页中的面板占位（root 替换后不可见，保留无害）
      slots.inject('settings.section', () => slots.register({ name: 'settings.section', id: 'archive-control', order: 1000, label: '智能体总控' }, () => e('div', null, '智能体总控已内置于全新主界面')));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
