/**
 * mcp/protocol.ts —— MCP（Model Context Protocol）协议实现
 *
 * MCP 基于 JSON-RPC 2.0，本文件实现服务端所需的最小方法集：
 *   - initialize                  握手
 *   - tools/list                  列出工具
 *   - tools/call                  调用工具
 *   - resources/list              （可选）列出资源
 *   - ping
 *
 * 实测：DSH 只有 `dsh-mcp-client`（客户端），没有 server 包，
 * 所以服务端需要自行实现。协议本身不复杂。
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** MCP 工具定义 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** MCP 工具调用结果 */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** 工具处理器 */
export type ToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult>;

/** MCP 服务端 */
export class McpServer {
  private tools = new Map<string, { def: McpTool; handler: ToolHandler }>();
  private serverInfo: { name: string; version: string };

  constructor(serverInfo: { name: string; version: string }) {
    this.serverInfo = serverInfo;
  }

  /** 注册工具 */
  tool(def: McpTool, handler: ToolHandler): void {
    this.tools.set(def.name, { def, handler });
  }

  /** 已注册工具定义 */
  listTools(): McpTool[] {
    return [...this.tools.values()].map((t) => t.def);
  }

  /**
   * 处理一条 JSON-RPC 请求，返回响应。
   * 通知（无 id）返回 null。
   */
  async handle(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const isNotification = req.id === undefined || req.id === null;
    const id = req.id ?? null;

    try {
      switch (req.method) {
        case 'initialize': {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {
                tools: { listChanged: false },
              },
              serverInfo: this.serverInfo,
            },
          };
        }

        case 'notifications/initialized':
        case 'initialized':
          return null;   // 通知无响应

        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };

        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: this.listTools() } };

        case 'tools/call': {
          const params = req.params ?? {};
          const name = String(params.name ?? '');
          const entry = this.tools.get(name);
          if (!entry) {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: JSON_RPC_ERRORS.METHOD_NOT_FOUND, message: `未知工具：${name}` },
            };
          }
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          try {
            const result = await entry.handler(args);
            return { jsonrpc: '2.0', id, result };
          } catch (e) {
            // 工具执行错误按 MCP 规范返回 isError 结果，而不是 JSON-RPC error
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: `工具执行失败：${String((e as Error)?.message ?? e)}` }],
                isError: true,
              },
            };
          }
        }

        case 'resources/list':
          return { jsonrpc: '2.0', id, result: { resources: [] } };

        case 'prompts/list':
          return { jsonrpc: '2.0', id, result: { prompts: [] } };

        default: {
          if (isNotification) return null;
          return {
            jsonrpc: '2.0',
            id,
            error: { code: JSON_RPC_ERRORS.METHOD_NOT_FOUND, message: `未知方法：${req.method}` },
          };
        }
      }
    } catch (e) {
      if (isNotification) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: { code: JSON_RPC_ERRORS.INTERNAL_ERROR, message: String((e as Error)?.message ?? e) },
      };
    }
  }

  /** 处理一行文本（JSON），返回响应行（可能为空） */
  async handleLine(line: string): Promise<string | null> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      return JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: JSON_RPC_ERRORS.PARSE_ERROR, message: 'JSON 解析失败' },
      });
    }
    // 批量请求支持
    if (Array.isArray(req)) {
      const results = await Promise.all((req as unknown as JsonRpcRequest[]).map((r) => this.handle(r)));
      const filtered = results.filter((r): r is JsonRpcResponse => r !== null);
      return filtered.length > 0 ? JSON.stringify(filtered) : null;
    }
    const res = await this.handle(req);
    return res ? JSON.stringify(res) : null;
  }
}

/** 便捷构造文本结果 */
export function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}
