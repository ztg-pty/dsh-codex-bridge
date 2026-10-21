#!/usr/bin/env node
/**
 * bin/mcp-stdio.js —— MCP Server 的 stdio 入口（独立 CLI）
 *
 * 用法（在支持 MCP 的客户端里配置）：
 *   Claude Code:  claude mcp add dsh-bridge -- node <绝对路径>/bin/mcp-stdio.js
 *   Cursor:       在 .cursor/mcp.json 里加
 *                 { "mcpServers": { "dsh-bridge": { "command": "node", "args": ["<绝对路径>/bin/mcp-stdio.js"] } } }
 *   Cline:        同上格式
 *
 * 协议：MCP over stdio（每行一个 JSON-RPC 消息）
 *
 * ★ 注意：这个文件是**构建产物**，源码在 `src/mcp/stdio-entry.ts`。
 */
import '../lib/mcp-stdio.js';
