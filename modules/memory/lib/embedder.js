/**
 * ollama embedding 客户端（基于 ollama 的向量数据库之"向量生成层"）。
 * 使用 Node 内置 fetch，无第三方依赖。默认模型 shaw/dmeta-embedding-zh（768 维）。
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'shaw/dmeta-embedding-zh:latest';
const DEFAULT_TIMEOUT_MS = 60000;
const BATCH_SIZE = 8; // 单次请求的最大文本条数，避免长文本超时

export class OllamaEmbedder {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]  ollama 服务地址
   * @param {string} [options.model]    embedding 模型名
   * @param {number}  [options.timeoutMs] 单请求超时
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** @returns {{model: string, dims: number, baseUrl: string}} 运行时信息 */
  describe() {
    return { model: this.model, dims: null, baseUrl: this.baseUrl };
  }

  /**
   * 把一段或一段列表文本转成向量。
   * @param {string|string[]} input
   * @returns {Promise<Float32Array|Float32Array[]>}
   */
  async embed(input) {
    const texts = Array.isArray(input) ? input : [input];
    if (texts.length === 0) return [];
    const all = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const chunk = texts.slice(i, i + BATCH_SIZE);
      const vectors = await this._embedChunk(chunk);
      for (const v of vectors) all.push(v);
    }
    return Array.isArray(input) ? all : all[0];
  }

  /** @param {string[]} texts */
  async _embedChunk(texts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(`embedding 请求失败（${this.baseUrl}，model=${this.model}）：${error.message}。请确认 ollama 服务已启动。`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`embedding 返回 HTTP ${response.status}：${body.slice(0, 300)}`);
    }
    const data = await response.json();
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
      throw new Error(`embedding 响应异常：期望 ${texts.length} 条向量，实际 ${data.embeddings?.length} 条`);
    }
    return data.embeddings.map((row) => Float32Array.from(row));
  }
}
