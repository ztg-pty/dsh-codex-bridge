/**
 * mcp/tools.ts —— MCP 工具注册
 *
 * 6 个工具：
 *   list_sessions      列出会话（可按客户端/目录/关键字过滤）
 *   get_context        获取压缩后的上下文（核心，200k 预算）
 *   push_context       把客户端传来的对话写入目标端
 *   transfer_session   端到端直接转换（不经客户端）
 *   summarize_session  单独生成摘要
 *   list_clients       列出可用客户端与能力
 */
import { McpServer, textResult, type McpTool } from './protocol.js';
import {
  availableAdapters, capabilityMatrix, listAllSessions,
  readSession, writeSession, transferSession, describeLoss,
} from '../adapters/registry.js';
import { summarizeSession, formatStats } from '../budget/summarize.js';
import { resolveBudget, DEFAULT_BUDGET, MODEL_CONTEXT_PRESETS } from '../budget/tokens.js';
import { probeAllClients, platformSupport } from '../host/clients.js';
import type { ClientKind, UirSession, UirTurn, UirStep } from '../uir/types.js';

/** 校验客户端类型 */
function assertClient(v: unknown, field: string): ClientKind {
  const s = String(v ?? '');
  const valid = availableAdapters();
  if (!valid.includes(s as ClientKind)) {
    throw new Error(`${field} 必须是以下之一：${valid.join(', ')}（收到：${s || '空'}）`);
  }
  return s as ClientKind;
}

/** 把纯文本消息数组转成 UIR 会话（供 push_context 使用） */
function messagesToUir(params: {
  messages: Array<{ role: string; content: string }>;
  title?: string;
  cwd?: string;
  client: ClientKind;
}): UirSession {
  const now = Date.now();
  const turns: UirTurn[] = [];
  let current: UirTurn | null = null;
  let step: UirStep | null = null;

  for (const m of params.messages) {
    const text = String(m.content ?? '');
    if (!text) continue;
    if (m.role === 'user') {
      current = {
        index: turns.length,
        startedAt: now,
        userMessages: [{ kind: 'text', role: 'user', text, tier: 'high' }],
        steps: [],
      };
      turns.push(current);
      step = { index: 0, blocks: [] };
      current.steps.push(step);
    } else if (m.role === 'assistant' && current && step) {
      step.blocks.push({ kind: 'text', role: 'assistant', text, tier: 'high' });
    } else if (m.role === 'tool' && current && step) {
      step.blocks.push({
        kind: 'tool-result',
        callId: `call-${turns.length}`,
        output: { text },
        isError: false,
        tier: 'critical',
      });
    }
  }

  return {
    id: `mcp-${now}`,
    title: params.title ?? '(来自 MCP)',
    cwd: params.cwd ?? process.cwd(),
    createdAt: now,
    updatedAt: now,
    origin: { client: 'mcp', originalId: `mcp-${now}` },
    turns,
  };
}

/** 注册全部 MCP 工具 */
export function registerTools(server: McpServer): void {
  // ── 1. list_clients ──
  server.tool(
    {
      name: 'list_clients',
      description: '列出本机可用的编程客户端（DSH / Codex / Zcode / Claude Code / WorkBuddy）及其能力与损失提示。',
      inputSchema: { type: 'object', properties: {} },
    },
    async () => {
      const clients = probeAllClients();
      const caps = capabilityMatrix();
      const platform = platformSupport();
      const lines: string[] = [];
      lines.push(`平台：${platform.note}`);
      lines.push('');
      lines.push('| 客户端 | 检测到 | 会话数 | 可读 | 可写 | 子代理 | 分支 |');
      lines.push('|---|---|---|---|---|---|---|');
      for (const c of clients) {
        const cap = caps.find((x) => x.client === c.kind);
        lines.push(
          `| ${c.label} | ${c.detected ? '✅' : '❌'} | ${c.sessionCount ?? '—'} | ${c.canRead ? '✅' : '—'} | ${c.canWrite ? '✅' : '—'} | ${cap?.supportsSubagent ? '✅' : '—'} | ${cap?.supportsBranching ? '✅' : '—'} |`,
        );
      }
      const missing = clients.filter((c) => !c.detected);
      if (missing.length > 0) {
        lines.push('');
        lines.push('未检测到：');
        for (const c of missing) lines.push(`- ${c.label}：${c.reason ?? '未知原因'}`);
      }
      return textResult(lines.join('\n'));
    },
  );

  // ── 2. list_sessions ──
  server.tool(
    {
      name: 'list_sessions',
      description: '列出各客户端的会话。可按客户端、工作目录、关键字过滤。',
      inputSchema: {
        type: 'object',
        properties: {
          client: { type: 'string', description: '限定客户端（dsh/codex/zcode/claude-code/workbuddy），不传则全部' },
          query: { type: 'string', description: '标题或路径关键字' },
          cwd: { type: 'string', description: '按工作目录过滤（包含匹配）' },
          limit: { type: 'number', description: '每端返回上限，默认 20' },
        },
      },
    },
    async (args) => {
      const clients = args.client ? [assertClient(args.client, 'client')] : undefined;
      const limit = Math.min(Number(args.limit ?? 20) || 20, 100);
      const r = await listAllSessions({ clients, limitPerClient: limit });

      let sessions = r.sessions;
      if (args.query) {
        const q = String(args.query).toLowerCase();
        sessions = sessions.filter((s) => s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q));
      }
      if (args.cwd) {
        const c = String(args.cwd).toLowerCase();
        sessions = sessions.filter((s) => s.cwd.toLowerCase().includes(c));
      }

      const lines: string[] = [];
      lines.push(`共 ${sessions.length} 个会话`);
      lines.push('');
      lines.push('| 客户端 | 会话 ID | 标题 | 轮次 | 更新 | 工作目录 |');
      lines.push('|---|---|---|---|---|---|');
      for (const s of sessions.slice(0, 200)) {
        const upd = new Date(s.updatedAt).toISOString().slice(0, 16).replace('T', ' ');
        lines.push(`| ${s.client} | \`${s.id}\` | ${s.title.slice(0, 50)} | ${s.turns ?? '—'} | ${upd} | \`${s.cwd.slice(0, 50)}\` |`);
      }
      if (r.errors.length > 0) {
        lines.push('');
        lines.push('部分客户端读取失败：');
        for (const e of r.errors) lines.push(`- ${e.client}：${e.message}`);
      }
      return textResult(lines.join('\n'));
    },
  );

  // ── 3. get_context ──（核心）
  server.tool(
    {
      name: 'get_context',
      description:
        '获取指定会话的上下文，自动压缩到 token 预算内。'
        + '预算可由 `model`（按模型上下文窗口自动定）或 `budget`（显式 token 数）指定，默认 200k。'
        + '技术细节（代码块、命令、路径、报错、参数）优先保留，超出预算时早期轮次折叠为摘要。',
      inputSchema: {
        type: 'object',
        properties: {
          client: { type: 'string', description: '客户端类型（必填）' },
          sessionId: { type: 'string', description: '会话 ID（必填）' },
          model: {
            type: 'string',
            description: '模型名（可选）。按模型上下文窗口自动定预算，'
              + '如 claude-sonnet-4-5→200k、gpt-4.1→1M、gemini-1.5-pro→2M、deepseek-v4→256k、glm-5→200k。'
              + '与 budget 同时传时 budget 优先。',
          },
          budget: { type: 'number', description: '显式 token 预算（可选，优先级最高，上限 2M）' },
          fidelity: { type: 'string', enum: ['full', 'balanced', 'compact'], description: '保真度，默认 balanced' },
          focus: { type: 'array', items: { type: 'string' }, description: '关注点关键字（提升匹配内容保留优先级）' },
        },
        required: ['client', 'sessionId'],
      },
    },
    async (args) => {
      const client = assertClient(args.client, 'client');
      const sessionId = String(args.sessionId ?? '');
      if (!sessionId) throw new Error('sessionId 不能为空');

      const model = args.model ? String(args.model) : undefined;
      const budgetArg = args.budget != null ? Number(args.budget) : undefined;
      const budgetInfo = resolveBudget({ budget: budgetArg, model });

      const read = await readSession(client, sessionId);
      const sum = summarizeSession(read.session, {
        budget: budgetArg,
        model,
        fidelity: args.fidelity as any,
        focus: Array.isArray(args.focus) ? args.focus.map(String) : undefined,
      });

      // 预算来源说明
      const sourceText = budgetInfo.source === 'model'
        ? `模型 ${model} → ${budgetInfo.modelPreset?.label ?? '预设'} ${budgetInfo.modelPreset?.context ?? budgetInfo.requested}`
        : budgetInfo.source === 'explicit'
          ? `显式指定 ${budgetInfo.requested}`
          : budgetInfo.source === 'clamped'
            ? `已裁剪到上限 ${budgetInfo.requested}`
            : `默认 ${budgetInfo.requested}`;

      const header = [
        `<!-- 会话上下文：${read.session.title} -->`,
        `<!-- 来源 ${client} · ${read.session.turns.length} 轮 · 预算 ${budgetInfo.effective}（${sourceText}，安全系数 92%） -->`,
        `<!-- ${formatStats(sum.stats).replace(/\n/g, ' | ')} -->`,
        '',
      ].join('\n');

      return textResult(header + sum.context);
    },
  );

  // ── 4. push_context ──
  server.tool(
    {
      name: 'push_context',
      description:
        '把当前对话内容写入指定客户端，成为该客户端的一个新会话。'
        + '用于「在任意 MCP 客户端里干活，结果存回 DSH/Codex/Zcode 等」。',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '目标客户端（必填）' },
          title: { type: 'string', description: '会话标题' },
          cwd: { type: 'string', description: '工作目录（默认当前目录）' },
          messages: {
            type: 'array',
            description: '对话消息数组',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string', enum: ['user', 'assistant', 'tool'] },
                content: { type: 'string' },
              },
              required: ['role', 'content'],
            },
          },
        },
        required: ['target', 'messages'],
      },
    },
    async (args) => {
      const target = assertClient(args.target, 'target');
      const messages = Array.isArray(args.messages) ? args.messages : [];
      if (messages.length === 0) throw new Error('messages 不能为空');

      const uir = messagesToUir({
        messages: messages as any,
        title: args.title ? String(args.title) : undefined,
        cwd: args.cwd ? String(args.cwd) : undefined,
        client: target,
      });

      const w = await writeSession(target, uir, {
        title: args.title ? String(args.title) : undefined,
        cwd: args.cwd ? String(args.cwd) : undefined,
      });

      if (!w.ok) {
        return textResult(`写入失败：${w.error?.message ?? '未知错误'}`, true);
      }
      return textResult([
        `✅ 已写入 ${target}`,
        `- 会话 ID：\`${w.targetId}\``,
        `- 位置：\`${w.location}\``,
        `- 记录数：${w.records}`,
        w.warnings.length > 0 ? `- 提示：${w.warnings.join('；')}` : '',
      ].filter(Boolean).join('\n'));
    },
  );

  // ── 5. transfer_session ──
  server.tool(
    {
      name: 'transfer_session',
      description: '把一个客户端的历史会话直接转换到另一个客户端（不经客户端传内容）。',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '源客户端（必填）' },
          fromId: { type: 'string', description: '源会话 ID（必填）' },
          to: { type: 'string', description: '目标客户端（必填）' },
          title: { type: 'string', description: '覆盖标题' },
          cwd: { type: 'string', description: '覆盖工作目录' },
        },
        required: ['from', 'fromId', 'to'],
      },
    },
    async (args) => {
      const from = assertClient(args.from, 'from');
      const to = assertClient(args.to, 'to');
      const fromId = String(args.fromId ?? '');
      if (!fromId) throw new Error('fromId 不能为空');
      if (from === to) throw new Error('源端与目标端相同，无需转换');

      const losses = describeLoss(from, to);
      const r = await transferSession({
        from, fromId, to,
        title: args.title ? String(args.title) : undefined,
        cwd: args.cwd ? String(args.cwd) : undefined,
      });

      const lines = [
        `✅ ${from} → ${to} 转换完成`,
        `- 源会话：${r.source.title}（${r.source.turns} 轮）`,
        `- 目标 ID：\`${r.target.id}\``,
        `- 位置：\`${r.target.location}\``,
        `- 记录数：${r.target.records}`,
      ];
      if (losses.length > 0) {
        lines.push('', '⚠️ 本次转换的已知损失：');
        for (const l of losses) lines.push(`- ${l}`);
      }
      if (r.warnings.length > 0) {
        lines.push('', '提示：');
        for (const w of r.warnings) lines.push(`- ${w}`);
      }
      return textResult(lines.join('\n'));
    },
  );

  // ── 6. summarize_session ──
  server.tool(
    {
      name: 'summarize_session',
      description: '只生成会话摘要（不返回完整上下文），适合快速了解历史。',
      inputSchema: {
        type: 'object',
        properties: {
          client: { type: 'string', description: '客户端（必填）' },
          sessionId: { type: 'string', description: '会话 ID（必填）' },
          budget: { type: 'number', description: '摘要目标 token，默认 8000' },
          model: { type: 'string', description: '模型名（可选，用于自动定预算；显式 budget 优先）' },
        },
        required: ['client', 'sessionId'],
      },
    },
    async (args) => {
      const client = assertClient(args.client, 'client');
      const sessionId = String(args.sessionId ?? '');
      if (!sessionId) throw new Error('sessionId 不能为空');
      const budget = args.budget != null ? Number(args.budget) : 8_000;
      const model = args.model ? String(args.model) : undefined;

      const read = await readSession(client, sessionId);
      const sum = summarizeSession(read.session, { budget, model, fidelity: 'compact' });

      const lines = [
        `# ${read.session.title}`,
        '',
        `来源 ${client} · ${read.session.turns.length} 轮 · 工作目录 \`${read.session.cwd}\``,
        '',
        formatStats(sum.stats),
        '',
        '## 轮次大纲',
        '',
      ];
      for (const o of sum.outline) {
        const files = o.files.length > 0 ? ` · 文件：${o.files.slice(0, 5).join(', ')}` : '';
        const tools = o.tools.length > 0 ? ` · 工具：${o.tools.join(', ')}` : '';
        lines.push(`- **第 ${o.turn} 轮**：${o.intent || '（无明确意图）'}${files}${tools}`);
      }
      lines.push('', '## 压缩上下文', '', sum.context);
      return textResult(lines.join('\n'));
    },
  );

  // ── 7. list_models ──
  server.tool(
    {
      name: 'list_models',
      description:
        '列出内置的模型上下文长度预设。调用 get_context 时可传 model 名自动定预算，'
        + '也可直接传 budget（显式 token 数，优先级更高）。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '按名称过滤（可选）' },
        },
      },
    },
    async (args) => {
      const q = args.query ? String(args.query).toLowerCase() : '';
      const rows = MODEL_CONTEXT_PRESETS.filter(
        (p) => !q || p.match.includes(q) || p.label.toLowerCase().includes(q),
      );
      const lines = [
        '# 模型上下文长度预设',
        '',
        `默认预算：${DEFAULT_BUDGET.toLocaleString()} tokens（未指定 model / budget 时）`,
        `安全系数：92%（实际可用 = 上下文 × 0.92）`,
        `硬上限：2,000,000 tokens`,
        '',
        '| 匹配片段 | 上下文窗口 | 实际可用 | 模型 |',
        '|---|---|---|---|',
      ];
      for (const p of rows) {
        lines.push(
          `| \`${p.match}\` | ${p.context.toLocaleString()} | ${Math.floor(p.context * 0.92).toLocaleString()} | ${p.label} |`,
        );
      }
      lines.push('');
      lines.push('用法示例：');
      lines.push('- `get_context({ client, sessionId, model: "claude-sonnet-4-5" })` → 按 200k 预算');
      lines.push('- `get_context({ client, sessionId, budget: 500000 })` → 显式 500k');
      lines.push('- 两者同时传时，`budget` 优先');
      return textResult(lines.join('\n'));
    },
  );
}

/** 创建并配置好工具的 MCP 服务端 */
export function createBridgeMcpServer(): McpServer {
  const server = new McpServer({ name: 'dsh-codex-bridge', version: '0.2.0' });
  registerTools(server);
  return server;
}
