// control Host RPC 验证：stub 服务 + 捕获 connection.rpc.handle('/archive-control', dispatch, options)
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// 2026-08-31 修复：apply 会立即触发 autoBackupCheck（写真实备份目录）。切换到临时 cwd，
// 使 DATA_ROOT/BACKUP_ROOT 落在 tmp 下（自动备份/导入测试的备份目录也由本脚本自建，无项目污染）。
// 2026-09-01：PROJECT_ROOT 改为 dataRoot 上级的上级（修复备份根错位回归）——为保持 PROJECT_ROOT=tmp
// 的语义，dataRoot 必须传 tmp/dsh/data（模拟真实层级 dsh/data），不能再用 cwd/data 兜底。
const tmp = mkdtempSync(join(tmpdir(), 'verify-rpc-'));
mkdirSync(join(tmp, 'dsh', 'data'), { recursive: true });
mkdirSync(join(tmp, 'backups', 'backup-2026-08-29T14-33-58'), { recursive: true });
writeFileSync(join(tmp, 'backups', 'backup-2026-08-29T14-33-58', 'memory.db'), '');
process.chdir(tmp);
const mod = await import('file:///C:/DSH-ARCHIVE/dsh/node_modules/dsh-archive-control/lib/index.js');

let handler = null;
let stdout = '';
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk) => { stdout += String(chunk); return true; };

const fake = (v) => ({ get: () => v, list: () => v, stats: () => v, snapshot: () => ({ rendered: 'x' }) });
// 2026-09-07：内存态 settings（models.setProviders 密钥保留合并逻辑的回归守卫依赖它）
const memSettings = { providers: [] };
const ctx = {
  root: { logger: () => ({ info: () => {}, warn: () => {} }) },
  on: () => {},
  parallel: (events, fn) => { fn(); return Promise.resolve(); },
  timer: { setInterval: () => 1, setTimeout: () => 1 },
  get: (name) => {
    if (name === 'agents') return {
      get: (id) => {
        const scopeKey = { __fakeScope: true };
        const agentCtx = {
          [Symbol('dsh.scope')]: scopeKey,
          get: (n) => {
            if (n === 'tools') return { schemas: () => [{ name: 'read', description: 'read file' }, { name: 'pwsh', description: 'shell' }] };
            if (n === 'skills') return { list: () => [{ name: 'skill-a', description: 'desc', whenToUse: 'w', source: 'test', provider: 'provider-p' }] };
            return undefined;
          },
        };
        return { ctx: agentCtx };
      },
    };
    if (name === 'skills') return { list: async () => [{ name: 'skill-a', description: 'desc', whenToUse: 'w', source: 'test', provider: 'provider-p' }] };
    if (name === 'settings') return {
      // 2026-09-07：改为内存态（原恒空对象无法验证 models.setProviders 的密钥保留合并逻辑）
      register: () => ({}),
      get: (ns) => (String(ns) === 'archive-models' ? { providers: memSettings.providers } : memSettings),
      update: async (ns, patch) => {
        if (String(ns) === 'archive-models' && Array.isArray(patch?.providers)) memSettings.providers = patch.providers;
        else Object.assign(memSettings, patch);
      },
    };
    if (name === 'credentials') return { peek: () => undefined, set: async () => {}, resolve: async () => undefined };
    if (name === 'directoryPicker') return { capability: () => ({ kind: 'native', pick: async (signal) => {
      // 2026-08-30 回归守卫：native pick 契约要求 AbortSignal（pick 内部会读 signal.aborted），
      // 未传 signal 是真实运行时报错的根因，这里必须捕获。
      if (!signal || signal.aborted !== false) throw new Error('pick 未收到有效 AbortSignal');
      return 'C:\\picked-dir';
    } }) };
    // 2026-09-04 permission.state/set stub：模拟 dsh-permission-presets 服务表面
    if (name === 'permissionPresets') return {
      names: ['read-only', 'workspace-write', 'danger-full-access'],
      current: () => 'workspace-write',
      optionOf: (n) => ({ value: n, name: n, description: 'stub' }),
      apply: () => {},
      set: () => {},
    };
    if (name === 'approval') return { setPolicy: () => {} };
    return undefined;
  },
  inject: (services, cb) => cb({
    connection: {
      rpc: {
        handle: (channel, dispatch, options) => {
          handler = { channel, dispatch, options };
        },
      },
    },
  }),
  sessions: {
    get: () => undefined,
    create: () => ({ append: () => ({}), id: 'session-main' }),
    list: () => [{ id: 'session-main', append: () => ({}) }],
    flush: async () => true,
  },
  persona: { get: () => ({ version: 1 }), stats: () => ({ version: 1, total: 4 }), history: (l) => [], set: (e, o) => ({ version: 2, added: e.length }), update: () => ({ modifiedBy: 'user' }), remove: () => ({ removed: true }), rollback: (v) => true },
  loop: { state: () => ({ mode: 'idle' }), stats: () => ({ cycleCount: 1 }), configure: (a) => ({ fallbackIntervalMs: a.fallbackIntervalMs }), trigger: () => ({ queued: true }),
    // 2026-09-04-2 思维预设 stub（get/save/preview）
    instructions: {
      get: () => ({ presets: [], activePresetId: '', entries: [], injectCapChars: 1200 }),
      save: (s) => ({ presets: [], activePresetId: '', entries: [], injectCapChars: 1200 }),
      preview: (t, p) => ({ activePresetId: '', injected: [], truncated: 0, budgetUsed: 0, injectCapChars: 1200 }),
    } },
  memory: { forgetStats: () => ({ total: 9 }), list: (o) => [], recall: async (q) => ({ results: [] }), get: () => null, update: () => ({ updated: true }), forget: () => ({ removed: true }), forgetRun: () => ({ softened: 1 }), restore: () => ({ restored: true }), forgottenList: () => [], integrate: async () => ({ skipped: true, reason: 'stub' }), importBackup: (p) => ({ ok: true, memories: 1, skipped: 0, profiles: 0, states: 0 }), profile: { list: () => [] }, state: { snapshot: () => ({ rendered: 'x' }) }, stats: () => ({ total: 9 }) },
  evolution: { view: (l) => ({ records: [] }), stats: () => ({ totalCandidates: 0 }), suggest: async () => ({ candidateIds: [] }), approve: async () => ({ applied: true }), reject: () => ({ rejected: true }), rollback: async () => ({ rolledBack: true }),
    // 2026-09-08 人格一键凝练 stub（persona.distillPreview/Apply 走 ctx.evolution）
    distillPersona: async () => ({ token: 'stub-token', direction: '', at: Date.now(), before: { version: 1, total: 2, bySection: { identity: 0, values: 0, traits: 1, style: 0, directives: 1, capabilities: 0 } }, after: { total: 2, bySection: { identity: 0, values: 0, traits: 1, style: 0, directives: 1, capabilities: 0 } }, entries: [{ section: 'traits', content: '凝练后的条目', importance: 0.7, mergedFrom: ['a'] }] }),
    applyPersonaDistill: async (t) => { if (t !== 'stub-token') throw new Error('凝练结果已失效或不存在'); return { applied: true, version: 5, added: 1 }; } },
  schedule: { list: () => [], create: (a) => ({ id: 't', task: a.task }), cancel: (id) => ({ cancelled: true }), stats: () => ({ byStatus: {} }) },
  notify: { view: (l) => ({ notifications: [] }), markRead: () => ({ marked: 0 }), clearRead: () => ({ removed: 0 }), stats: () => ({ total: 0 }) },
  virtualClock: { format: () => '2026-08-29 01:30:00' },
  // 2026-08-31 人格一致性 stub（consistency ops / evolution.approve 联动）
  consistency: {
    state: () => ({ enabled: true, alpha: 6, beta: 12, calibrated: true, turnCount: 5, waypointCount: 1, stats: { checks: 5, pass: 4, suspicious: 0, blocked: 1 } }),
    stats: () => ({ checks: 5 }),
    pca: () => ({ points: [{ x: 1, y: 2, z: 3, kind: 'turn' }] }),
    log: () => ({ rejected: [], revisions: [], corrections: [] }),
    revisionsMap: () => ({ map: { 22: { v: 'suspicious', r: 'rev' } }, alpha: 6, beta: 12 }),
    configure: (a) => ({ enabled: a.enabled !== false }),
    onEvolutionApproved: async () => ({ ok: true }),
    close: () => {},
  },
  // 2026-08-31 潜意识系统 stub（subconscious ops / 自进化页）
  subconscious: {
    state: () => ({ enabled: true, autoApply: false, condenseModel: 'phi', llmModel: 'deepseek', poolCount: 0, draftCount: 0, whisper: null, stats: {}, thresholds: {} }),
    stats: () => ({}),
    log: () => ({ drafts: [], pool: [] }),
    configure: (a) => ({ enabled: a.enabled !== false, autoApply: a.autoApply === true }),
    run: async () => ({ ok: true }),
    model: async () => ({ installed: false, name: 'phi3:mini', sizeMb: 0 }),
    modelDownload: async () => ({ started: true }),
    modelRemove: async () => ({ removed: true }),
    close: () => {},
  },
};

const api = mod.apply(ctx, { dataRoot: join(tmp, 'dsh', 'data') });
process.stdout.write = origWrite;

const failures = [];
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

const call = async (op, args) => handler.dispatch('archive-control', { args: { op, args } });
console.log('--- 断言 ---');
check('注册 RPC（handle 专属通道）', typeof handler === 'object' && typeof handler.dispatch === 'function');
check('通道为 /archive-control', handler.channel === '/archive-control');
check('authority trusted-host', handler.options?.authority === 'trusted-host');
check('overview 概览', (await call('overview')).ok === true);
check('clock.now', (await call('clock.now')).value.now.includes('2026'));
check('persona.stats', (await call('persona.stats')).value.total === 4);
check('persona.set', (await call('persona.set', { entries: [{ section: 'traits', content: 'x' }] })).value.added === 1);
check('persona.remove', (await call('persona.remove', { id: 'x' })).value.removed === true);
check('persona.distillPreview 凝练预览', (await call('persona.distillPreview')).value.token === 'stub-token');
check('persona.distillApply 缺 token 拒绝', (await call('persona.distillApply')).error !== undefined);
check('persona.distillApply 非法 token 拒绝', (await call('persona.distillApply', { token: 'bad' })).error !== undefined);
check('persona.distillApply 有效 token 应用', (await call('persona.distillApply', { token: 'stub-token' })).value.applied === true);
check('loop.configure', (await call('loop.configure', { fallbackIntervalMs: 60000 })).value.fallbackIntervalMs === 60000);
check('loop.history 活动流', (await call('loop.history', { limit: 10 })).ok === true);
check('loop.instructions.get', (await call('loop.instructions.get')).ok === true);
check('loop.instructions.save', (await call('loop.instructions.save', { state: { presets: [], activePresetId: '', entries: [], injectCapChars: 1200 } })).ok === true);
check('loop.instructions.preview', (await call('loop.instructions.preview', { text: '测试' })).value.injected.length === 0);
check('memory.forgetStats', (await call('memory.forgetStats')).value.total === 9);
check('memory.forget', (await call('memory.forget', { id: 'x' })).value.removed === true);
check('evolution.approve 需 confirm', (await call('evolution.approve', { candidateId: 'x', confirm: true })).ok === true);
check('schedule.create', (await call('schedule.create', { task: '喝水' })).value.task === '喝水');
check('notify.view', (await call('notify.view')).ok === true);
check('tools.list', (await call('tools.list')).value.tools.length === 2);
check('skills.list', (await call('skills.list')).value.skills[0].name === 'skill-a');
check('models.get', (await call('models.get')).value.providers.length === 0);
// 2026-09-07 回归守卫（高危修复）：setProviders 必须先存密钥，再以"空 apiKey 整表回写"（模拟
// 启停/删除/编辑留空），断言密钥不被清空——此前把空 apiKey 直接落盘会静默清空全部自定义提供商密钥。
await call('models.setProviders', { providers: [{ id: 'p1', name: 'x', baseURL: 'http://x/v1', model: 'm', apiKey: 'sk-keep', enabled: true }] });
const kept = await call('models.get');
check('models 密钥已存', kept.value.providers.length === 1 && kept.value.providers[0].apiKeySet === true);
await call('models.setProviders', { providers: [{ id: 'p1', name: 'x', baseURL: 'http://x/v1', model: 'm', enabled: true }] });
const kept2 = await call('models.get');
check('models 留空整表回写不清密钥', kept2.value.providers.length === 1 && kept2.value.providers[0].apiKeySet === true);
const kept3 = await call('models.setProviders', { providers: [{ id: 'p1', name: 'x', baseURL: 'http://x/v1', model: 'm', apiKey: 'sk-new', enabled: true }] });
const kept4 = await call('models.get');
check('models 显式传新密钥可覆盖', kept4.value.providers.length === 1 && kept4.value.providers[0].apiKeySet === true);
check('models.setDeepSeekKey', (await call('models.setDeepSeekKey', { key: 'sk-x' })).value.saved === true);
check('vision.config.get', (await call('vision.config.get')).ok === true);
check('vision.config.set', (await call('vision.config.set', { baseURL: 'http://x/v1' })).value.saved === true);
check('system.shutdown 保存并退出', (await call('system.shutdown')).ok === true);
check('backup.list', (await call('backup.list')).ok === true);
check('report.daily 无 LLM 时给出明确错误', (await call('report.daily')).error.message.includes('LLM'));
check('memory.integrate', (await call('memory.integrate')).value.skipped === true);
check('memory.import', (await call('memory.import', { backupDir: 'backup-2026-08-29T14-33-58' })).ok === true);
check('memory.batchForget', (await call('memory.batchForget', { ids: ['a', 'b'] })).value.removed === 2);
check('notify.clearRead', (await call('notify.clearRead')).value.removed === 0);
check('system.tokenUsage', (await call('system.tokenUsage')).ok === true);
check('system.metrics', (await call('system.metrics')).ok === true);
check('system.dnd get', (await call('system.dnd')).value.enabled === false);
check('system.dnd set', (await call('system.dnd', { enabled: true })).value.enabled === true);
check('system.restore 非法参数拒绝', (await call('system.restore', { backupDir: '../evil' })).error !== undefined);
check('directory.pick（native 选择器返回路径）', (await call('directory.pick')).value.path === 'C:\\picked-dir');
check('consistency.state', (await call('consistency.state')).value.calibrated === true);
check('consistency.pca', Array.isArray((await call('consistency.pca')).value.points) && (await call('consistency.pca')).value.points[0].kind === 'turn');
check('consistency.revisions 渲染层映射', (await call('consistency.revisions')).value.map[22]?.v === 'suspicious');
check('consistency.configure 开关', (await call('consistency.configure', { enabled: false })).value.enabled === false);
check('evolution.approve 联动一致性', (await call('evolution.approve', { candidateId: 'x', confirm: true })).ok === true);
check('subconscious.state', (await call('subconscious.state')).value.condenseModel === 'phi');
check('subconscious.model Phi 状态', (await call('subconscious.model')).value.name === 'phi3:mini');
check('subconscious.configure 开关', (await call('subconscious.configure', { enabled: false })).value.enabled === false);
// 一键更新（方案 D，2026-09-02）：stub 环境 PROJECT_ROOT=tmp 非 git 仓库 → check 离线兜底；apply 缺脚本报错
const updCheck = await call('updater.check');
check('updater.check 离线兜底（非 git 仓库/网络不可达时给出明确状态）', updCheck.ok === true && updCheck.value?.offline === true && typeof updCheck.value?.currentVersion === 'string');
check('updater.apply 缺脚本返回协议错误', (await call('updater.apply')).error !== undefined);
const unknownOpError = (await call('nope')).error;
check('未知 op 返回协议错误对象（{code,message,details}）', !!unknownOpError && typeof unknownOpError === 'object' && unknownOpError.code === 'internal' && typeof unknownOpError.message === 'string' && typeof unknownOpError.details === 'object');
// 2026-09-04 permission ops（stub 无 session → state 走空事件折叠；set 缺 session 报协议错误）
const permState = await call('permission.state', { sessionId: 'session-main' });
check('permission.state 可用且返回预设选项', permState.ok === true && permState.value?.available === true && Array.isArray(permState.value?.options) && permState.value.options.length >= 2);
check('permission.set 未知预设拒绝', (await call('permission.set', { preset: 'nope' })).error !== undefined);
check('permission.set 无 live session 返回协议错误', (await call('permission.set', { preset: 'danger-full-access' })).error !== undefined);
check('ops 清单', api.ops.length >= 25);
check('启动行', stdout.includes('[archive-control] ready'));
console.log(failures.length === 0 ? '\nCONTROL RPC VERIFY: ALL PASS' : `\nVERIFY: ${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
