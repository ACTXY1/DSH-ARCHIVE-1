// dsh-archive-web-perf Host 半部：总控 Web 性能优化，三端（主包/Windows 分发包/手机分发包）同步生效。
//  - /assets 前缀路由：gzip 压缩（Accept-Encoding 协商，内存缓存压缩结果）+ Cache-Control immutable 一年。
//    assets 文件名带内容 hash（Vite 产物），内容不可变 → 永久缓存安全；浏览器刷新不再重新下载。
//  - /archive-sw.js：Service Worker。对 /plugins/* 客户端模块 cache-first + 后台静默更新：
//    刷新页面时全部命中 SW 缓存、零下载（no-cache 响应头 + rev hash URL 的模块每次刷新都被浏览器重下的问题消除）。
//  - tapIndex 注入 SW 注册脚本（updateViaCache:none，SW 文件无缓存头也会被浏览器重新检查）。
// 不动 DSH 本体 node_modules（升级会被覆盖且无法分发到手机包）：/assets 通过 loader 解析
//  frontend-static 的 distIndex 接管，与本体 fallback 并存。
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { gzipSync } from 'node:zlib';

const name = 'dsh-archive-web-perf';
const inject = ['webServer', 'loader'];

const HTML_MIME = 'text/html; charset=utf-8';
const MIME = {
  '.html': HTML_MIME,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};
const STATIC_MISS_CODES = new Set(['ENOENT', 'EISDIR', 'ENOTDIR']);
const GZIP_MAX = 2 * 1024 * 1024; // 只压缩/缓存 < 2MB 的文本资源，防内存膨胀

/** gzip 压缩结果缓存：key=`绝对路径:字节数`（文件内容 hash 化文件名 + 长度即版本），缓冲池小、无失效压力。 */
const gzipCache = new Map();

function bootLine(line) {
  try { process.stdout.write(line + '\n'); } catch { /* ignore */ }
}

/** 解析 frontend-static 的 dist/index.html 绝对路径。
 *  ① 优先：loader 已加载 entry（bundle 行显式配置的 frontend-static config.distIndex，!!js 求值后的绝对路径）；
 *  ② 兜底（三端一致）：dsh 启动时 healProfilesModuleFallback 会把 dsh 安装的全部依赖 link 到
 *     ~/.dsh/profiles/node_modules（Windows 主包与手机 Termux install.sh 均生成），
 *     用 createRequire 从该目录解析 @deepseek-ai/dsh-web-frontend 包 → dist/index.html。 */
function findDistIndex(ctx) {
  try {
    const entries = typeof ctx.loader?.entries === 'function' ? ctx.loader.entries() : [];
    for (const entry of entries) {
      const opts = entry?.options ?? {};
      if (opts.name === '@deepseek-ai/dsh-host-frontend-static') {
        const di = opts.config?.distIndex;
        if (typeof di === 'string' && di.length > 0) return di;
      }
    }
  } catch { /* ignore */ }
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
    const req = createRequire(join(dshHome, 'profiles', 'noop.js'));
    const pkg = req.resolve('@deepseek-ai/dsh-web-frontend/package.json');
    const dist = join(dirname(pkg), 'dist', 'index.html');
    if (existsSync(dist)) return dist;
  } catch { /* ignore */ }
  return null;
}

/** /assets 处理器：语义与本体 frontend-static 一致（405/403/404/MIME），附加 gzip + immutable 缓存头。 */
async function serveAssets(req, res, distRoot) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return;
  }
  const rawPath = new URL(req.url ?? '/', 'http://x').pathname;
  const pathname = decodeURIComponent(rawPath);
  const target = resolve(normalize(join(distRoot, pathname)));
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  let body;
  let type;
  try {
    body = await readFile(target);
    type = MIME[extname(target)] ?? 'application/octet-stream';
  } catch (error) {
    if (STATIC_MISS_CODES.has(error.code)) {
      res.writeHead(404);
      res.end();
      return;
    }
    throw error;
  }
  const accept = String(req.headers['accept-encoding'] ?? '');
  const compressible = body.length >= 256 && body.length <= GZIP_MAX
    && (type.startsWith('text/') || type.includes('javascript') || type.includes('json') || type === 'image/svg+xml');
  const useGzip = compressible && accept.includes('gzip');
  if (useGzip) {
    const key = `${target}:${body.length}`;
    let gz = gzipCache.get(key);
    if (gz === undefined) {
      gz = gzipSync(body, { level: 9 });
      if (gzipCache.size > 64) gzipCache.clear(); // 简易防膨胀（正常 assets 远少于 64 个）
      gzipCache.set(key, gz);
    }
    res.writeHead(200, {
      'content-type': type,
      'content-encoding': 'gzip',
      vary: 'accept-encoding',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(gz);
    return;
  }
  res.writeHead(200, {
    'content-type': type,
    vary: 'accept-encoding',
    'cache-control': 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

/** Service Worker：只处理同源 GET /plugins/*（客户端模块，no-cache + rev hash → 每次刷新都被重下）。
 *  cache-first：命中缓存直接返回，**不做后台静默更新**——模块 URL 带 rev hash（内容哈希），
 *  代码更新 → rev 变 → 缓存 miss → 自动重新下载，天然无陈旧缓存。
 *   性能修复：原实现命中后 e.waitUntil(fetch) 后台重下全部模块——每次开页/刷新都会
 *  向服务端并发发起 ~45 个模块请求，且 waitUntil 在页面关闭后仍在 SW 中继续；反复开/关页面时
 *  后台请求累积淹没服务端（手机实测：某次刷新突然卡 1 分钟+）。rev hash 已保证新鲜度，删除后台更新。
 *  其余请求（/、/api、/describe-image 等）一律直通，不缓存动态数据。 */
const SW_SOURCE = [
  "var CACHE='dsh-archive-v1';",
  "self.addEventListener('install',function(){self.skipWaiting();});",
  "self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim());});",
  "self.addEventListener('fetch',function(e){",
  "  var req=e.request;",
  "  if(req.method!=='GET')return;",
  "  var u;try{u=new URL(req.url);}catch(err){return;}",
  "  if(u.origin!==location.origin||u.pathname.indexOf('/plugins/')!==0)return;",
  "  e.respondWith(caches.open(CACHE).then(function(cache){",
  "    return cache.match(req).then(function(hit){",
  "      if(hit)return hit;",
  "      return fetch(req).then(function(res){",
  "        if(res&&res.ok)e.waitUntil(cache.put(req,res.clone()));",
  "        return res;",
  "      }).catch(function(){return new Response('',{status:504,statusText:'offline'});});",
  "    });",
  "  }));",
  "});",
].join('\n');

/** 注入 SW 注册脚本（load 事件后注册，不阻塞首屏；updateViaCache:none 保证 SW 更新即时生效）。 */
const SW_REGISTER_SCRIPT = '<script>if("serviceWorker" in navigator){window.addEventListener("load",function(){navigator.serviceWorker.register("/archive-sw.js",{updateViaCache:"none"}).catch(function(){})})}</script>';

function injectSwRegistration(html) {
  const body = /<body(?:\s[^>]*)?>/i.exec(html);
  if (body !== null) {
    const at = body.index + body[0].length;
    return `${html.slice(0, at)}${SW_REGISTER_SCRIPT}${html.slice(at)}`;
  }
  return `${html}${SW_REGISTER_SCRIPT}`;
}

function apply(ctx) {
  const distIndex = findDistIndex(ctx);
  const distRoot = distIndex ? dirname(distIndex) : null;
  if (distRoot !== null) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/assets',
      handler: (req, res) => serveAssets(req, res, distRoot),
    }), 'web-perf: /assets gzip+immutable');
    bootLine(`[archive-web-perf] /assets 已接管（gzip+immutable 一年缓存）: ${distRoot}`);
  } else {
    bootLine('[archive-web-perf] WARN: 未解析到 frontend-static distIndex，/assets 优化跳过（Service Worker 仍生效）');
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/archive-sw.js',
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
      if (req.method === 'HEAD') res.end();
      else res.end(SW_SOURCE);
    },
  }), 'web-perf: /archive-sw.js');
  ctx.effect(() => ctx.webServer.tapIndex(injectSwRegistration), 'web-perf: sw registration');
  bootLine('[archive-web-perf] Service Worker 就绪（/archive-sw.js；/plugins 模块刷新零下载）');
}

export { apply, inject, name };
