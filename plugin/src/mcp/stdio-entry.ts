/**
 * mcp/stdio-entry.ts —— MCP Server stdio 入口
 *
 * 独立进程运行，通过 stdin/stdout 与 MCP 客户端通信（每行一个 JSON-RPC）。
 * 构建产物：`lib/mcp-stdio.js`，由 `bin/mcp-stdio.js` 转发。
 *
 * ⚠️ stdout 只能输出协议消息！所有日志必须写 stderr。
 */
import { createInterface } from 'node:readline';
import { createBridgeMcpServer } from './tools.js';

const server = createBridgeMcpServer();

function log(msg: string): void {
  // 必须写 stderr，stdout 留给协议
  process.stderr.write(`[dsh-codex-bridge-mcp] ${msg}\n`);
}

log(`启动：${server.listTools().length} 个工具（${server.listTools().map((t) => t.name).join(', ')}）`);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  void (async () => {
    try {
      const out = await server.handleLine(trimmed);
      if (out) process.stdout.write(out + '\n');
    } catch (e) {
      log(`处理失败：${String((e as Error)?.message ?? e)}`);
    }
  })();
});

rl.on('close', () => {
  log('stdin 关闭，退出');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('收到 SIGINT，退出');
  process.exit(0);
});

process.on('uncaughtException', (e) => {
  log(`未捕获异常：${e?.message ?? e}`);
});

process.on('unhandledRejection', (e) => {
  log(`未处理拒绝：${String(e)}`);
});
