// dsh-archive-web-fetch：宿主侧 URL 抓取 provider，注册到 ctx.web 的 fetch。
//
// 背景（2026-08-30 排查结论）：DSH 的 Windows 沙箱（windows-acl 受限令牌，
// CreateRestrictedToken flags=13 = DISABLE_MAX_PRIVILEGE|LUA_TOKEN|WRITE_RESTRICTED）
// 会让 schannel 的 AcquireCredentialsHandle 失败（SEC_E_NO_CREDENTIALS 0x8009030e），
// 因此沙箱内的 pwsh/curl 全部 HTTPS 请求在 TLS 握手阶段死掉（"基础连接已经关闭"），
// 而 HTTP/TCP 与宿主进程的 undici（OpenSSL 系）完全正常。web_search 工具本身是宿主侧
// 的所以一直可用；缺的只是"取网页正文"这一环。本模块在宿主进程内用全局 fetch 抓取，
// 供 @deepseek-ai/dsh-tool-web 的 web_fetch 工具（preset 内 fetch: true）执行。
//
// 零 @deepseek-ai 运行时依赖（profile node_modules 未装 dsh-web）：不 import WebError，
// 出错抛普通 Error，工具层会包装为 isError 结果。
const name = 'archive-web-fetch';
const inject = ['web'];

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_BODY_CHARS = 100000;

class ArchiveFetchProvider {
  id = 'archive-local';

  constructor(timeoutMs) {
    this.timeoutMs = timeoutMs;
  }

  available() {
    return true;
  }

  async fetch(request, signal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal !== undefined) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error('archive-web-fetch timeout')), this.timeoutMs);
    try {
      const response = await fetch(request.url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': 'deepseek-harness/0.0.1',
          accept: 'text/html,text/plain,*/*',
        },
      });
      const contentType = response.headers.get('content-type') ?? '';
      // 2026-08-30 审计修复①：二进制类型直接拒绝——response.text() 会把 zip/图片/pdf 无差别
      // 按 UTF-8 解码成乱码返回；且大文件会整块缓冲进堆。
      if (/^(image\/|audio\/|video\/|application\/(octet-stream|zip|gzip|x-tar|pdf)|font\/)/i.test(contentType)) {
        throw new Error(`archive-web-fetch 拒绝二进制内容类型 ${contentType}（${request.url}）`);
      }
      // 2026-08-30 审计修复②：content-length 预检，超过字节预算直接中止，防大文件 OOM
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (Number.isFinite(declared) && declared > MAX_BODY_CHARS * 4) {
        throw new Error(`archive-web-fetch 内容过大（content-length=${declared}B，上限约 ${MAX_BODY_CHARS * 4}B）`);
      }
      const text = await response.text();
      const kind = /text\/html|application\/xhtml\+xml/i.test(contentType) ? 'html' : 'text';
      const truncated = text.length > MAX_BODY_CHARS;
      return {
        url: response.url || request.url,
        statusCode: response.status,
        body: { kind, content: truncated ? text.slice(0, MAX_BODY_CHARS) : text },
        truncated,
      };
    } catch (error) {
      if (signal?.aborted) throw new Error(`archive-web-fetch aborted: ${String(signal.reason ?? 'cancelled')}`);
      const timedOut = controller.signal.aborted && !(signal?.aborted === true);
      throw new Error(
        timedOut
          ? `archive-web-fetch timeout after ${this.timeoutMs}ms`
          : `archive-web-fetch request failed: ${String(error)}`,
      );
    } finally {
      clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
    }
  }
}

function apply(ctx, config = {}) {
  // 2026-08-30 审计修复：timeoutMs 非法值（0/负数/NaN）回退默认，避免 setTimeout 立即触发致所有抓取必超时
  const raw = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_TIMEOUT_MS;
  ctx.web.registerFetchProvider(new ArchiveFetchProvider(timeoutMs));
  ctx.logger?.info?.(`archive-web-fetch: provider registered (id=archive-local, timeoutMs=${timeoutMs})`);
}

export { apply, inject, name };
