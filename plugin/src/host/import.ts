/**
 * host/import.ts —— 扫描 Codex 会话 + 执行导入
 *
 * 流程：扫描目录 → 列会话（全部，时间倒序）→ 用户勾选 → 逐条转换 → 写入 DSH → 记日志
 * 失败隔离：单个会话失败不影响其他会话（每条独立 try/catch）
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CodexSessionSummary, ImportReport } from '../shared/types.js';
import { BridgeError, describeError } from '../shared/errors.js';
import {
  readRollout, extractMeta, summarize, parseRolloutText,
  readSessionIndex, threadIdFromFileName,
} from '../convert/codex-reader.js';
import { codexToDsh } from '../convert/codex2dsh.js';
import { writeDshSessionFile } from '../convert/dsh-store.js';
import {
  defaultCodexSessionsDir, defaultDshSessionsRoot, dirAccessible, listRolloutFiles,
  codexSessionIndexFile, codexArchivedSessionsDir, projectKey, workspaceRegistryFile,
} from './paths.js';
import { logOp } from './oplog.js';

/** 扫描结果 */
export interface ScanResult {
  codexDir: string;
  sessions: CodexSessionSummary[];
  totalFiles: number;
  skipped: Array<{ file: string; reason: string }>;
}

/**
 * 扫描 Codex 会话，以 session_index.jsonl 的 thread 为准（去重、标题权威）。
 * 对每个 thread 定位其 rollout 文件（主文件，非 turn 分片），提取元数据。
 */
export async function scanCodexSessions(opts: {
  codexDir?: string;
  maxBytes?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<ScanResult> {
  const codexDir = opts.codexDir?.trim() || defaultCodexSessionsDir();

  const acc = await dirAccessible(codexDir);
  if (!acc.ok) {
    if (acc.reason === 'ENOENT') throw new BridgeError('CODEX_DIR_NOT_FOUND', undefined, { dir: codexDir });
    if (acc.reason === 'EACCES') throw new BridgeError('PERMISSION_DENIED', undefined, { path: codexDir });
    throw new BridgeError('SCAN_FAILED', undefined, { reason: '目录不可访问' });
  }

  const files = await listRolloutFiles(codexDir);
  // ★ 归档目录里的 rollout 也一并纳入（session_index 里有 23 个 thread 只存在于归档）
  const archivedFiles = await listRolloutFiles(codexArchivedSessionsDir());
  const allFiles = [...files, ...archivedFiles];
  if (allFiles.length === 0) throw new BridgeError('CODEX_DIR_EMPTY');

  // ★ 读取 Codex 官方索引（权威 thread 列表 + thread_name）
  const index = await readSessionIndex(codexSessionIndexFile());

  // 建立 threadId → rollout 文件映射（取每个 thread 的主文件；多个分片取最新修改）
  const fileByThread = new Map<string, { path: string; mtimeMs: number }>();
  for (const f of allFiles) {
    const tid = threadIdFromFileName(f);
    if (!tid) continue;
    let st;
    try { st = await fsp.stat(f); } catch { continue; }
    const prev = fileByThread.get(tid);
    if (!prev || st.mtimeMs > prev.mtimeMs) {
      fileByThread.set(tid, { path: f, mtimeMs: st.mtimeMs });
    }
  }

  const sessions: CodexSessionSummary[] = [];
  const skipped: Array<{ file: string; reason: string }> = [];
  let done = 0;

  // 以索引的 thread 为权威列表；同一 id 多条记录时取最新一条（续聊，标题带 (2) 后缀）
  const latestByThread = new Map<string, { id: string; thread_name: string; updated_at: string }>();
  for (const e of index) {
    const prev = latestByThread.get(e.id);
    if (!prev || (e.updated_at ?? '') >= (prev.updated_at ?? '')) {
      latestByThread.set(e.id, { id: e.id, thread_name: e.thread_name, updated_at: e.updated_at ?? '' });
    }
  }
  const threadIds = latestByThread.size > 0
    ? [...latestByThread.keys()]
    : [...fileByThread.keys()];   // 索引为空时退回按文件去重

  for (const tid of threadIds) {
    done++;
    opts.onProgress?.(done, threadIds.length);
    const entry = latestByThread.get(tid);
    const fileRec = fileByThread.get(tid);
    if (!fileRec) {
      skipped.push({ file: `(thread ${tid})`, reason: '索引中有该会话，但找不到对应的 rollout 文件' });
      continue;
    }
    try {
      const { lines, sizeBytes } = await readRollout(fileRec.path, opts.maxBytes);
      const meta = extractMeta(lines);
      if (!meta) {
        skipped.push({ file: fileRec.path, reason: describeError('NO_SESSION_META') });
        continue;
      }
      const summary = summarize(lines, meta, fileRec.path, sizeBytes);
      // ★ 标题用 Codex 官方的 thread_name（比从内容猜可靠）
      if (entry?.thread_name) summary.title = entry.thread_name.slice(0, 80);
      sessions.push(summary);
    } catch (e) {
      const be = e as BridgeError;
      skipped.push({
        file: fileRec.path,
        reason: be instanceof BridgeError
          ? describeError(be.code, be.detail ?? {})
          : String((e as Error)?.message ?? e),
      });
    }
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);

  await logOp({
    op: 'scan', phase: 'ok',
    message: `扫描完成：${sessions.length} 个会话（去重后），跳过 ${skipped.length} 个`,
    detail: { codexDir, totalFiles: allFiles.length, indexedThreads: latestByThread.size },
  });

  return { codexDir, sessions, totalFiles: allFiles.length, skipped };
}

/** 单条导入结果 */
export interface ImportOneResult {
  report: ImportReport;
  targetFile?: string;
}

/**
 * 导入单个会话。
 * @param mode 'skip' 已存在则跳过；'overwrite' 覆盖
 * @param targetCwd 目标 DSH 工作区路径（决定会话归属与显示位置）
 */
export async function importOne(
  filePath: string,
  opts: {
    dshSessionsRoot?: string;
    mode?: 'skip' | 'overwrite';
    maxBytes?: number;
    targetCwd?: string;
    title?: string;
  } = {},
): Promise<ImportOneResult> {
  const dshRoot = opts.dshSessionsRoot ?? defaultDshSessionsRoot();
  const mode = opts.mode ?? 'skip';

  await logOp({ op: 'import', phase: 'start', message: `开始导入 ${path.basename(filePath)}`, detail: { filePath } });

  let lines;
  let sizeBytes;
  try {
    const r = await readRollout(filePath, opts.maxBytes);
    lines = r.lines;
    sizeBytes = r.sizeBytes;
  } catch (e) {
    const be = e as BridgeError;
    const report: ImportReport = {
      sourceId: '', sourceFile: filePath, ok: false,
      stats: zeroStats(), encryptedDetail: [], warnings: [],
      error: {
        code: be?.code ?? 'SCAN_FAILED',
        message: be instanceof BridgeError
          ? describeError(be.code, be.detail ?? {})
          : String((e as Error)?.message ?? e),
      },
    };
    await logOp({ op: 'import', phase: 'fail', message: report.error!.message, detail: { filePath } });
    return { report };
  }

  // ★ 标题：优先用传入的 title；否则按 thread id 从 session_index 查 Codex 官方 thread_name
  let title = opts.title?.trim();
  if (!title) {
    try {
      const tid = threadIdFromFileName(filePath);
      if (tid) {
        const index = await readSessionIndex(codexSessionIndexFile());
        const entry = index.find((e) => e.id === tid);
        if (entry?.thread_name) title = entry.thread_name;
      }
    } catch { /* 标题兜底失败不影响导入 */ }
  }

  // 转换
  let session;
  let report: ImportReport;
  try {
    const r = codexToDsh(lines, { sourceFile: filePath, title });
    session = r.session;
    report = r.report;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    report = {
      sourceId: '', sourceFile: filePath, ok: false,
      stats: zeroStats(), encryptedDetail: [], warnings: [],
      error: { code: 'CONVERT_FAILED', message: describeError('CONVERT_FAILED', { reason: msg }) },
    };
    await logOp({ op: 'import', phase: 'fail', message: report.error!.message, detail: { filePath } });
    return { report };
  }

  if (!report.ok) {
    await logOp({ op: 'import', phase: 'fail', message: `转换失败：${report.error?.message}`, detail: { filePath } });
    return { report };
  }

  // ★ 目标工作区：未指定则用 Codex 会话原始 cwd；cwd 必须是绝对路径
  const targetCwd = opts.targetCwd?.trim() || (session.header.cwd ?? process.cwd());
  // 覆盖 header.cwd，使 DSH 的 candidateMatches 把它归入对应 workspace
  session.header.cwd = targetCwd;

  // ★ 会话目录 = sessions/<projectKey(cwd)>/<sessionId>/（DSH 派生索引据此发现会话）
  const projectGroup = projectKey(targetCwd);
  const targetDir = path.join(dshRoot, projectGroup, session.header.id);

  // 已存在处理
  try {
    await fsp.stat(path.join(targetDir, 'session.v4.jsonl.zstd'));
    if (mode === 'skip') {
      report.ok = false;
      report.error = {
        code: 'DSH_SESSION_EXISTS',
        message: describeError('DSH_SESSION_EXISTS', { id: session.header.id }),
      };
      await logOp({ op: 'import', phase: 'fail', message: report.error.message, sessionId: session.header.id });
      return { report };
    }
    // overwrite：先备份旧文件
    const backupPath = path.join(targetDir, `backup-${Date.now()}.jsonl.zstd`);
    await fsp.copyFile(path.join(targetDir, 'session.v4.jsonl.zstd'), backupPath);
    await logOp({
      op: 'backup', phase: 'ok',
      message: `覆盖前已备份旧会话到 ${path.basename(backupPath)}`,
      sessionId: session.header.id,
    });
  } catch { /* 不存在，正常写入 */ }

  try {
    const targetFile = await writeDshSessionFile(session, targetDir);
    report.targetSessionId = session.header.id;

    // ★ 关键：把新会话注册进目标工作区的 sessionIds，DSH 才会在聊天列表显示它
    try {
      await registerSessionToWorkspace(session.header.id, targetCwd);
    } catch (regErr) {
      report.warnings.push(`会话已写入，但注册到工作区失败：${String((regErr as Error)?.message ?? regErr)}（可能需要重启 DSH 后手动刷新）`);
      await logOp({ op: 'import', phase: 'fail', sessionId: session.header.id, message: `注册到工作区失败：${String((regErr as Error)?.message ?? regErr)}` });
    }

    await logOp({
      op: 'import', phase: 'ok',
      sessionId: session.header.id,
      message: `导入成功：${report.stats.turns} 轮 / ${report.stats.messages} 条消息 / ${report.stats.toolCalls} 次工具调用`,
      detail: {
        sourceFile: filePath, sizeBytes,
        targetCwd,
        encryptedBlocks: report.stats.encryptedBlocks,
        encryptedBytes: report.stats.encryptedBytes,
      },
    });
    return { report, targetFile };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    report.ok = false;
    report.error = { code: 'DSH_WRITE_FAILED', message: describeError('DSH_WRITE_FAILED', { reason: msg }) };
    await logOp({ op: 'import', phase: 'fail', message: report.error.message, detail: { filePath } });
    return { report };
  }
}

/** 批量导入（逐条隔离失败） */
export async function importMany(
  filePaths: string[],
  opts: { dshSessionsRoot?: string; mode?: 'skip' | 'overwrite'; maxBytes?: number; targetCwd?: string } = {},
): Promise<{ results: ImportReport[]; ok: number; failed: number }> {
  const results: ImportReport[] = [];
  for (const f of filePaths) {
    const { report } = await importOne(f, opts);
    results.push(report);
  }
  const ok = results.filter((r) => r.ok).length;
  return { results, ok, failed: results.length - ok };
}

/** 从内存文本导入（Web 端上传模式） */
export async function importFromText(
  text: string,
  fileName: string,
  opts: { dshSessionsRoot?: string; mode?: 'skip' | 'overwrite'; targetCwd?: string } = {},
): Promise<ImportOneResult> {
  const { lines, badLines } = parseRolloutText(text, fileName);
  if (lines.length === 0) {
    return {
      report: {
        sourceId: '', sourceFile: fileName, ok: false,
        stats: zeroStats(), encryptedDetail: [], warnings: [],
        error: { code: 'JSON_PARSE_FAILED', message: describeError('JSON_PARSE_FAILED', { file: fileName, line: 1 }) },
      },
    };
  }

  const r = codexToDsh(lines, { sourceFile: fileName });
  const report = r.report;
  if (badLines.length > 0) {
    report.warnings.push(`共 ${badLines.length} 行 JSON 损坏，已跳过（首行：第 ${badLines[0]} 行）`);
  }
  if (!report.ok) return { report };

  const dshRoot = opts.dshSessionsRoot ?? defaultDshSessionsRoot();
  const targetCwd = opts.targetCwd?.trim() || (r.session.header.cwd ?? process.cwd());
  r.session.header.cwd = targetCwd;
  const targetDir = path.join(dshRoot, projectKey(targetCwd), r.session.header.id);

  try {
    await fsp.stat(path.join(targetDir, 'session.v4.jsonl.zstd'));
    if ((opts.mode ?? 'skip') === 'skip') {
      report.ok = false;
      report.error = { code: 'DSH_SESSION_EXISTS', message: describeError('DSH_SESSION_EXISTS', { id: r.session.header.id }) };
      return { report };
    }
  } catch { /* 不存在 */ }

  try {
    const targetFile = await writeDshSessionFile(r.session, targetDir);
    await logOp({
      op: 'import', phase: 'ok', sessionId: r.session.header.id,
      message: `上传导入成功（${fileName}）`,
      detail: { encryptedBlocks: report.stats.encryptedBlocks },
    });
    return { report, targetFile };
  } catch (e) {
    report.ok = false;
    report.error = { code: 'DSH_WRITE_FAILED', message: describeError('DSH_WRITE_FAILED', { reason: String((e as Error)?.message ?? e) }) };
    return { report };
  }
}

function zeroStats() {
  return {
    turns: 0, steps: 0, messages: 0, toolCalls: 0, toolResults: 0,
    subagents: 0, encryptedBlocks: 0, encryptedBytes: 0,
  };
}

/**
 * 把新导入的会话注册进目标工作区的 sessionIds 数组（DSH 聊天列表据此显示会话）。
 *
 * 实测机制（dsh-workspace 源码）：
 *   - workspace.json 的 tables.workspaces.<id>.sessionIds 是持久化的会话归属列表
 *   - 会话要显示，必须：文件在正确目录 + header.cwd 匹配 workspace.path + sessionId 在该数组
 *   - DSH 只在首次启动（!initialized）时 bootstrap 扫描目录；已初始化后新文件不会自动注册
 *
 * 因此导入后需直接改写 workspace.json，把 sessionId 前置到对应 workspace 的 sessionIds。
 * 注意：DSH 运行中可能缓存此文件，写入后需 DSH 重启（或触发 workspace 重载）才完全生效；
 * 但至少落盘后，重启必然能看到。
 */
async function registerSessionToWorkspace(sessionId: string, targetCwd: string): Promise<void> {
  const file = workspaceRegistryFile();
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    // 没有 workspace.json 时无法注册（此时用户可能尚未初始化任何工作区）
    return;
  }
  const data = JSON.parse(raw);
  const tables = data?.tables?.workspaces;
  if (!tables) return;

  // 规范化目标路径（与 DSH 存的 path 对比用反斜杠形式）
  const targetPath = targetCwd.replace(/\//g, '\\');
  for (const key of Object.keys(tables)) {
    const ws = tables[key];
    if (typeof ws?.path !== 'string') continue;
    if (ws.path.replace(/\//g, '\\') !== targetPath) continue;

    const ids: string[] = Array.isArray(ws.sessionIds) ? ws.sessionIds : [];
    if (ids.includes(sessionId)) return;   // 已注册
    ws.sessionIds = [sessionId, ...ids];
    ws.updatedAt = new Date().toISOString();
    await fsp.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return;
  }
  // 目标工作区不在 registry 里（可能用户新建的路径还没被 DSH 记录）
}
