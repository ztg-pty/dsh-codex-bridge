/**
 * host/routes.ts —— 插件 HTTP 路由（服务端 ↔ 浏览器 UI）
 *
 * 安全约束（对齐 DSH 插件惯例）：
 *   - 仅接受 loopback 访问（Host / Origin 校验）
 *   - 所有写操作需显式 POST
 *   - 响应体大小受限
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { scanCodexSessions, importMany, importFromText } from './import.js';
import { listExportable, exportMany, exportManyToWorkbuddy } from './export.js';
import { workbuddyAvailable, listWorkbuddySessions } from './wb-store.js';
import { readRecentLogs } from './oplog.js';
import { BridgeError, describeError } from '../shared/errors.js';
import { defaultCodexSessionsDir, defaultDshSessionsRoot, listWorkspaces, listRolloutFiles } from './paths.js';
import { registerToCodex } from './codex-index.js';
import { probeAllClients, platformSupport } from './clients.js';
import {
  capabilityMatrix, availableAdapters, listAllSessions,
  readSession, writeSession, transferSession, describeLoss,
} from '../adapters/registry.js';
import { summarizeSession, formatStats } from '../budget/summarize.js';
import { effectiveBudget } from '../budget/tokens.js';
import { createBridgeMcpServer } from '../mcp/tools.js';

// ★ 官方命名空间（实测 dsh-workbuddy-connect 用 /plugins/<包名>/...）
const ROUTE_BASE = '/plugins/dsh-codex-bridge';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostIsLoopback(host?: string): boolean {
  if (!host) return false;
  let h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end !== -1 && LOOPBACK_HOSTS.has(h.slice(0, end + 1));
  }
  const colon = h.lastIndexOf(':');
  if (colon !== -1 && /^\d+$/.test(h.slice(colon + 1))) h = h.slice(0, colon);
  return LOOPBACK_HOSTS.has(h);
}

function originIsLoopback(origin?: string): boolean {
  if (!origin || origin.trim() === '') return true; // 非浏览器客户端无 Origin
  try {
    const u = new URL(origin);
    return LOOPBACK_HOSTS.has(u.hostname) || u.hostname === '::1';
  } catch { return false; }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    size += buf.length;
    if (size > limit) throw new BridgeError('FILE_TOO_LARGE', undefined, { file: '请求体', size, limit });
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 统一错误响应 */
function fail(res: ServerResponse, e: unknown): void {
  const be = e as BridgeError;
  if (be instanceof BridgeError) {
    json(res, 400, { ok: false, code: be.code, message: describeError(be.code, be.detail ?? {}) });
    return;
  }
  json(res, 500, { ok: false, code: 'SCAN_FAILED', message: describeError('SCAN_FAILED', { reason: String((e as Error)?.message ?? e) }) });
}

/**
 * 挂载路由。
 * @param router 宿主提供的路由注册接口（由 index.ts 适配）
 */
export function mountRoutes(router: {
  get(path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void): void;
  post(path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void): void;
}): void {
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!hostIsLoopback(req.headers.host)) { json(res, 403, { ok: false, message: '仅允许本机访问' }); return false; }
    if (!originIsLoopback(req.headers.origin)) { json(res, 403, { ok: false, message: '来源不是本机页面' }); return false; }
    return true;
  };

  // GET /codex-bridge/status —— 环境与配置状态
  router.get(`${ROUTE_BASE}/status`, async (req, res) => {
    if (!guard(req, res)) return;
    json(res, 200, {
      ok: true,
      codexDir: defaultCodexSessionsDir(),
      dshSessionsRoot: defaultDshSessionsRoot(),
    });
  });

  // GET /codex-bridge/codex/sessions —— 扫描 Codex 会话列表
  router.get(`${ROUTE_BASE}/codex/sessions`, async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const codexDir = url.searchParams.get('dir') ?? undefined;
      const result = await scanCodexSessions({ codexDir });
      json(res, 200, { ok: true, ...result });
    } catch (e) { fail(res, e); }
  });

  // GET /codex-bridge/workspaces —— 列出现有 DSH 工作区（导入时选目标）
  router.get(`${ROUTE_BASE}/workspaces`, async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const workspaces = await listWorkspaces();
      json(res, 200, { ok: true, workspaces });
    } catch (e) { fail(res, e); }
  });

  // POST /codex-bridge/import —— 导入选中会话
  router.post(`${ROUTE_BASE}/import`, async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const files: string[] = Array.isArray(body.files) ? body.files : [];
      if (files.length === 0) throw new BridgeError('NO_SELECTION');
      const mode = body.mode === 'overwrite' ? 'overwrite' : 'skip';
      const targetCwd: string | undefined = typeof body.targetCwd === 'string' && body.targetCwd.trim() ? body.targetCwd : undefined;
      const r = await importMany(files, {
        dshSessionsRoot: body.dshSessionsRoot,
        mode,
        maxBytes: body.maxBytes,
        targetCwd,
      });
      // ok 表示请求成功，succ 表示成功条数（避免同名字段互相覆盖）
      json(res, 200, { ok: true, succ: r.ok, failed: r.failed, results: r.results });
    } catch (e) { fail(res, e); }
  });

  // POST /codex-bridge/import-upload —— Web 端上传导入
  router.post(`${ROUTE_BASE}/import-upload`, async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const text: string = body.text ?? '';
      const fileName: string = body.fileName ?? 'uploaded.jsonl';
      if (!text) throw new BridgeError('JSON_PARSE_FAILED', undefined, { file: fileName, line: 1 });
      const mode = body.mode === 'overwrite' ? 'overwrite' : 'skip';
      const r = await importFromText(text, fileName, {
        dshSessionsRoot: body.dshSessionsRoot,
        mode,
      });
      json(res, 200, { ok: true, ...r });
    } catch (e) { fail(res, e); }
  });

  // POST /codex-bridge/register-codex —— 把 Codex 目录里未注册的 rollout 注册进索引
  //   Codex 的会话列表读 state_5.sqlite 的 threads 表，不扫描目录。
  //   导出文件复制进 Codex 目录后，必须调用本接口 Codex 才会显示。
  router.post(`${ROUTE_BASE}/register-codex`, async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      let files: string[] = Array.isArray(body.files) ? body.files : [];
      if (files.length === 0) {
        // 未指定则扫描 Codex sessions 目录下所有 rollout
        const dir = defaultCodexSessionsDir();
        files = await listRolloutFiles(dir);
      }
      if (files.length === 0) {
        json(res, 200, { ok: true, registered: [], skipped: [], failed: [], dbPath: '', indexPath: '' });
        return;
      }
      const r = await registerToCodex(files);
      json(res, 200, { ok: true, ...r });
    } catch (e) { fail(res, e); }
  });

  // GET /codex-bridge/dsh/sessions —— 列出可导出的 DSH 会话
  router.get(`${ROUTE_BASE}/dsh/sessions`, async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const root = url.searchParams.get('root') ?? undefined;
      const sessions = await listExportable(root);
      json(res, 200, { ok: true, sessions });
    } catch (e) { fail(res, e); }
  });

  // POST /codex-bridge/export —— 导出选中会话
  router.post(`${ROUTE_BASE}/export`, async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const ids: string[] = Array.isArray(body.sessionIds) ? body.sessionIds : [];
      if (ids.length === 0) throw new BridgeError('NO_SELECTION');
      const r = await exportMany(ids, {
        dshSessionsRoot: body.dshSessionsRoot,
        codexSessionsDir: body.codexSessionsDir,
        doBackup: body.doBackup !== false,
        trimContext: body.trimContext === true,
        budget: body.budget != null ? Number(body.budget) : undefined,
        model: body.model ? String(body.model) : undefined,
      });
      json(res, 200, {
        ok: true, succ: r.ok, failed: r.failed,
        backupDir: r.backupDir, outDir: r.outDir, results: r.results,
      });
    } catch (e) { fail(res, e); }
  });

  // POST /codex-bridge/export-workbuddy —— 把选中会话直接导入 WorkBuddy
  router.post(`${ROUTE_BASE}/export-workbuddy`, async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const ids: string[] = Array.isArray(body.sessionIds) ? body.sessionIds : [];
      if (ids.length === 0) throw new BridgeError('NO_SELECTION');
      const r = await exportManyToWorkbuddy(ids, { dshSessionsRoot: body.dshSessionsRoot });
      json(res, 200, { ok: true, succ: r.ok, failed: r.failed, results: r.results });
    } catch (e) { fail(res, e); }
  });

  // GET /codex-bridge/workbuddy/status —— WorkBuddy 可用性与现有会话
  router.get(`${ROUTE_BASE}/workbuddy/status`, async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const available = workbuddyAvailable();
      const sessions = available ? await listWorkbuddySessions() : [];
      json(res, 200, { ok: true, available, sessionCount: sessions.length, sessions });
    } catch (e) { fail(res, e); }
  });

  // GET /codex-bridge/logs —— 操作日志
  router.get(`${ROUTE_BASE}/logs`, async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const limit = Number(url.searchParams.get('limit') ?? 100) || 100;
      const logs = await readRecentLogs(Math.min(limit, 500));
      json(res, 200, { ok: true, logs });
    } catch (e) { fail(res, e); }
  });

  // ══════════════════ 跨端互通（UIR） ══════════════════

  // GET /codex-bridge/clients —— 五端客户端探测 + 能力矩阵 + 平台说明
  router.get(`${ROUTE_BASE}/clients`, async (req, res) => {
    if (!guard(req, res)) return;
    try {
      json(res, 200, {
        ok: true,
        clients: probeAllClients(),
        capabilities: capabilityMatrix(),
        uirAdapters: availableAdapters(),
        platform: platformSupport(),
      });
    } catch (e) { fail(res, e); }
  });

  // GET /codex-bridge/sessions/all —— 列出所有可用客户端的会话
  router.get(`${ROUTE_BASE}/sessions/all`, async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const clientsParam = url.searchParams.get('clients');
      const clients = clientsParam
        ? clientsParam.split(',').map((s) => s.trim()).filter(Boolean) as any[]
        : undefined;
      const limit = Number(url.searchParams.get('limit') ?? 50) || 50;
      const r = await listAllSessions({ clients, limitPerClient: Math.min(limit, 200) });
      json(res, 200, { ok: true, sessions: r.sessions, errors: r.errors });
    } catch (e) { fail(res, e); }
  });

  // GET /codex-bridge/loss?from=&to= —— 转换损失提示
  router.get(`${ROUTE_BASE}/loss`, async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const from = url.searchParams.get('from') as any;
      const to = url.searchParams.get('to') as any;
      if (!from || !to) throw new BridgeError('NO_SELECTION', '缺少 from 或 to 参数');
      json(res, 200, { ok: true, losses: describeLoss(from, to) });
    } catch (e) { fail(res, e); }
  });

  // POST /codex-bridge/transfer —— 跨端转换（read A → UIR → write B）
  router.post(`${ROUTE_BASE}/transfer`, async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const from = body.from as any;
      const fromId = String(body.fromId ?? '');
      const to = body.to as any;
      if (!from || !fromId || !to) {
        throw new BridgeError('NO_SELECTION', '缺少 from / fromId / to 参数');
      }
      if (from === to) {
        throw new BridgeError('CONVERT_FAILED', undefined, { reason: '源端与目标端相同，无需转换' });
      }
      const r = await transferSession({
        from, fromId, to,
        title: typeof body.title === 'string' ? body.title : undefined,
        cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
      });
      json(res, 200, { ...r, ok: true });
    } catch (e) { fail(res, e); }
  });

  // POST /codex-bridge/context/preview —— 生成压缩上下文预览
  router.post(`${ROUTE_BASE}/context/preview`, async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const client = body.client as any;
      const sessionId = String(body.sessionId ?? '');
      if (!client || !sessionId) {
        throw new BridgeError('NO_SELECTION', '缺少 client / sessionId 参数');
      }
      const budget = Number(body.budget ?? 200_000);
      const read = await readSession(client, sessionId);
      const sum = summarizeSession(read.session, {
        budget,
        fidelity: body.fidelity,
        focus: Array.isArray(body.focus) ? body.focus.map(String) : undefined,
      });
      json(res, 200, {
        ok: true,
        session: {
          client,
          id: sessionId,
          title: read.session.title,
          cwd: read.session.cwd,
          turns: read.session.turns.length,
        },
        context: sum.context,
        outline: sum.outline,
        stats: sum.stats,
        statsText: formatStats(sum.stats),
        budget: { requested: budget, effective: effectiveBudget(budget) },
      });
    } catch (e) { fail(res, e); }
  });

  // ══════════════════ MCP Server（HTTP 传输） ══════════════════
  // 让任意支持 MCP 的客户端通过 HTTP 接入本插件。
  // 注意：这是简化版 HTTP 传输（非 SSE 流式），适用于一次性请求-响应。
  const mcpServer = createBridgeMcpServer();

  // POST /codex-bridge/mcp —— JSON-RPC over HTTP
  router.post(`${ROUTE_BASE}/mcp`, async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const raw = await readBody(req);
      const out = await mcpServer.handleLine(raw);
      if (!out) {
        // 通知类消息无响应
        json(res, 200, { ok: true, notification: true });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(out);
    } catch (e) { fail(res, e); }
  });

  // GET /codex-bridge/mcp/tools —— 便于调试：列出工具定义
  router.get(`${ROUTE_BASE}/mcp/tools`, async (req, res) => {
    if (!guard(req, res)) return;
    try {
      json(res, 200, { ok: true, tools: mcpServer.listTools() });
    } catch (e) { fail(res, e); }
  });
}

export { ROUTE_BASE };
