/**
 * GitHub 官方 Remote MCP 客户端（浏览器直连，Streamable HTTP 协议）
 *
 * 官方端点：https://api.githubcopilot.com/mcp/（github-mcp-server/remote）
 * - CORS 完全开放（Allow-Origin: *，Allow-Headers: *），浏览器可直接调用
 * - 认证：用户 GitHub PAT（Bearer Token），与仓库管理共用同一 Token
 * - 工具面：官方维护的 44 个 GitHub 读写工具（issues/PRs/文件/搜索/CI 等）
 *
 * 协议要点（MCP Streamable HTTP）：
 * - initialize → 响应头 Mcp-Session-Id → 后续请求携带同头
 * - 响应为 text/event-stream（event: message + data: JSON-RPC）或纯 JSON
 * - tools/call 返回 { content: [{ type: "text", text }] }
 */

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
  text: string;
  isError?: boolean;
}

export type McpState = "idle" | "connecting" | "ready" | "error";

export interface McpClientOptions {
  token: string;
  endpoint?: string;
  onState?: (state: McpState, info?: string) => void;
  /** 单次请求超时（ms） */
  timeoutMs?: number;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

const DEFAULT_ENDPOINT = "https://api.githubcopilot.com/mcp/";

/** 解析 SSE 文本：提取所有 data: 行（允许一个响应含多个事件） */
function parseSse(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) out.push(line.slice(5).trimStart());
  }
  return out;
}

/** 从 Response 流式读取文本（兼容 SSE 流与一次性 JSON） */
async function readResponseBody(res: Response): Promise<string> {
  const ct = res.headers.get("content-type") ?? "";
  if (!res.body) return "";
  if (ct.includes("text/event-stream")) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      full += decoder.decode(value, { stream: true });
    }
    full += decoder.decode();
    return full;
  }
  return res.text();
}

export class GitHubMcpClient {
  private token: string;
  private endpoint: string;
  private onState?: (state: McpState, info?: string) => void;
  private timeoutMs: number;
  private sessionId: string | null = null;
  private reqSeq = 0;
  state: McpState = "idle";
  serverInfo: Record<string, unknown> | null = null;
  instructions: string = "";

  constructor(opts: McpClientOptions) {
    this.token = opts.token;
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.onState = opts.onState;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  private setState(s: McpState, info?: string) {
    this.state = s;
    this.onState?.(s, info);
  }

  /** 底层 RPC：发送 JSON-RPC 请求，返回解析后的响应 */
  private async rpc<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("mcp-timeout")), this.timeoutMs);
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener("abort", onOuterAbort);
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${this.token}`,
          ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++this.reqSeq,
          method,
          params,
        }),
        signal: controller.signal,
      });
      const sid = res.headers.get("Mcp-Session-Id");
      if (sid) this.sessionId = sid;
      const text = await readResponseBody(res);
      if (!res.ok) {
        throw new Error(`GitHub MCP 服务错误（HTTP ${res.status}）：${text.slice(0, 200)}`);
      }
      // 优先解析纯 JSON；否则从 SSE 提取 data 行
      const parts = parseSse(text);
      const candidates = parts.length ? parts : [text];
      let lastError: unknown = null;
      for (const cand of candidates) {
        try {
          const msg = JSON.parse(cand) as JsonRpcResponse;
          if (msg.error) {
            throw new Error(`MCP 错误：${msg.error.message}（code ${msg.error.code}）`);
          }
          return msg.result as T;
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError instanceof Error ? lastError : new Error("MCP 响应解析失败");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  /** 建立会话：initialize + 通知 initialized */
  async connect(signal?: AbortSignal): Promise<void> {
    this.setState("connecting");
    try {
      const init = await this.rpc<{
        protocolVersion: string;
        capabilities: Record<string, unknown>;
        serverInfo: Record<string, unknown>;
        instructions?: string;
      }>("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "GitHubM", version: "1.0" },
      }, signal);
      this.serverInfo = init.serverInfo ?? null;
      this.instructions = init.instructions ?? "";
      // initialized 通知：fire-and-forget（MCP 通知无 JSON-RPC 响应，不可用 rpc 等待）
      try {
        await fetch(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${this.token}`,
            ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        });
      } catch { /* 通知无响应，忽略 */ }
      this.setState("ready");
    } catch (e) {
      this.setState("error", (e as Error).message);
      throw e;
    }
  }

  /** 获取全部工具 Schema（官方 GitHub 工具面） */
  async listTools(signal?: AbortSignal): Promise<McpToolSchema[]> {
    const result = await this.rpc<{ tools?: McpToolSchema[] }>("tools/list", {}, signal);
    return result?.tools ?? [];
  }

  /** 调用工具：自动处理会话失效重连一次 */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    try {
      return await this.callToolRaw(name, args, signal);
    } catch (e) {
      // 会话失效（session 过期）→ 重连后重试一次
      const msg = (e as Error).message ?? "";
      if (/HTTP 4(00|01|04|10)/.test(msg) && this.sessionId) {
        this.sessionId = null;
        await this.connect(signal);
        return this.callToolRaw(name, args, signal);
      }
      throw e;
    }
  }

  private async callToolRaw(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const result = await this.rpc<{
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
      structuredContent?: unknown;
    }>("tools/call", { name, arguments: args }, signal);
    const texts: string[] = [];
    for (const c of result?.content ?? []) {
      if (c.type === "text" && typeof c.text === "string") texts.push(c.text);
    }
    if (result?.structuredContent) {
      try { texts.push(JSON.stringify(result.structuredContent)); } catch { /* ignore */ }
    }
    return { text: texts.join("\n"), isError: result?.isError === true };
  }

  /** 断开：清会话 */
  disconnect() {
    this.sessionId = null;
    this.setState("idle");
  }
}

/**
 * 本地 MCP 工具缓存：tools/list 结果较大（44 个工具 Schema），
 * 缓存到 localStorage，24 小时内不重复拉取；MCP 不可达时用缓存兜底。
 */
const TOOLS_CACHE_KEY = "ai_mcp_tools_cache_v1";

export function loadCachedTools(): { tools: McpToolSchema[]; cachedAt: number } | null {
  try {
    const raw = localStorage.getItem(TOOLS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { tools: McpToolSchema[]; cachedAt: number };
    if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCachedTools(tools: McpToolSchema[]) {
  try {
    localStorage.setItem(TOOLS_CACHE_KEY, JSON.stringify({ tools, cachedAt: Date.now() }));
  } catch { /* 存储满等场景忽略 */ }
}

export function loadCachedInstructions(): string {
  try {
    return localStorage.getItem("ai_mcp_instructions_v1") ?? "";
  } catch {
    return "";
  }
}

export function saveCachedInstructions(instructions: string) {
  try {
    localStorage.setItem("ai_mcp_instructions_v1", instructions);
  } catch { /* ignore */ }
}
