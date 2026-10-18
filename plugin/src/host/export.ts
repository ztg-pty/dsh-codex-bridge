/**
 * host/export.ts —— 导出 DSH 会话为 OpenAI 兼容 JSONL + 备份 Codex 旧文件
 *
 * 关键设计（对齐你的原始需求）：
 *  - 导出只写进受控输出目录，**绝不直接写入 Codex 会话目录**（避免破坏进行中的会话）
 *  - 导出瞬间自动备份 Codex 目录中的同名旧 JSONL
 *  - 完成提示必须告知：手动复制 + 备份存放位置
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ExportReport } from '../shared/types.js';
import { BridgeError, describeError } from '../shared/errors.js';
import { readDshSessionFile, listDshSessions } from '../convert/dsh-store.js';
import { dshToCodex } from '../convert/dsh2codex.js';
import { defaultCodexSessionsDir, defaultDshSessionsRoot, backupDir, exportDir } from './paths.js';
import { logOp } from './oplog.js';
import { writeWorkbuddySession, workbuddyAvailable } from './wb-store.js';

/** 可导出的 DSH 会话摘要 */
export interface DshSessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sizeBytes: number;
  turns: number;
  filePath: string;
  /** 所属项目目录（projectKey 形式，用于区分同名会话） */
  project: string;
  /** 是否为空会话（只有 header、无消息） */
  isEmpty: boolean;
}

/** 列出 DSH 会话（供 UI 勾选） */
export async function listExportable(dshSessionsRoot?: string): Promise<DshSessionSummary[]> {
  const root = dshSessionsRoot ?? defaultDshSessionsRoot();
  const rows = await listDshSessions(root);
  const out: DshSessionSummary[] = [];

  for (const r of rows) {
    try {
      const s = readDshSessionFile(r.filePath);
      let turns = 0;
      let messageCount = 0;
      // ★ 标题取【最后一个】session/title 事件（DSH 的 foldSessionTitle 也是 findLast）
      let titleFromEvent = '';
      for (const e of s.events) {
        if (e.type === 'session/title') titleFromEvent = String((e.data as any)?.title ?? '');
        if (e.type === 'turn/start') turns++;
        if (e.type === 'user/message' || e.type === 'assistant/message') messageCount++;
      }

      // 无 title 事件时退回首条用户消息
      let title = titleFromEvent;
      if (!title) {
        for (const e of s.events) {
          if (e.type === 'user/message') {
            const text = (e.data as any)?.content?.find((b: any) => b?.type === 'text')?.text ?? '';
            if (text && !/^# AGENTS\.md instructions/.test(text)) { title = text.slice(0, 60); break; }
          }
        }
      }
      const isEmpty = messageCount === 0 && turns === 0;

      out.push({
        id: s.header.id,
        title: title || (isEmpty ? '(空会话)' : '(无标题)'),
        createdAt: s.header.createdAt,
        updatedAt: r.mtime,
        sizeBytes: r.sizeBytes,
        turns,
        filePath: r.filePath,
        project: r.projectDir.split(/[\\/]/).filter(Boolean).pop() ?? '',
        isEmpty,
      });
    } catch {
      // 损坏会话不进列表
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 备份 Codex 目录中与该会话对应的旧 JSONL。
 *
 * 匹配策略（按可靠性排序）：
 *   1. 文件名包含 thread id
 *   2. 同 cwd 下最近修改的 rollout（保守做法：全部同名日期目录）
 */
async function backupCodexFiles(codexSessionsDir: string): Promise<{ dir: string; files: string[] }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = backupDir(stamp);
  await fsp.mkdir(target, { recursive: true });

  const copied: string[] = [];
  async function walk(dir: string, depth = 0): Promise<void> {
    if (depth > 6) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!/^rollout-.*\.jsonl(\.zst)?$/.test(ent.name)) continue;
      // 保留相对目录结构，便于还原
      const rel = path.relative(codexSessionsDir, full);
      const dest = path.join(target, rel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(full, dest);
      copied.push(rel);
    }
  }
  await walk(codexSessionsDir);
  return { dir: target, files: copied };
}

/** 导出结果 */
export interface ExportOneResult {
  report: ExportReport;
  outFile: string;
  backupDir: string;
  backupFiles: string[];
}

/**
 * 导出单个 DSH 会话。
 * @param doBackup 是否备份 Codex 目录旧 JSONL（默认 true）
 */
export async function exportOne(
  sessionId: string,
  opts: {
    dshSessionsRoot?: string;
    codexSessionsDir?: string;
    doBackup?: boolean;
  } = {},
): Promise<ExportOneResult> {
  const dshRoot = opts.dshSessionsRoot ?? defaultDshSessionsRoot();
  const codexDir = opts.codexSessionsDir ?? defaultCodexSessionsDir();
  const doBackup = opts.doBackup !== false;
  const outDir = exportDir();

  await logOp({ op: 'export', phase: 'start', sessionId, message: `开始导出 ${sessionId}` });

  // 1. 定位并读取 DSH 会话
  const rows = await listDshSessions(dshRoot);
  // 兼容两种写法：完整 session id，或去掉 "session-" 前缀的裸 id
  const row = rows.find((r) => r.id === sessionId)
    ?? rows.find((r) => r.id === `session-${sessionId}`)
    ?? rows.find((r) => r.id.replace(/^session-/, '') === sessionId.replace(/^session-/, ''));
  if (!row) {
    const report: ExportReport = {
      sourceSessionId: sessionId, ok: false,
      stats: { lines: 0, messages: 0, toolCalls: 0, bytes: 0 }, warnings: [],
      error: { code: 'SCAN_FAILED', message: `未找到会话 ${sessionId}` },
    };
    await logOp({ op: 'export', phase: 'fail', sessionId, message: report.error!.message });
    return { report, outFile: '', backupDir: '', backupFiles: [] };
  }
  // 统一用规范 id（带 session- 前缀）后续派生 thread id 与日志
  sessionId = row.id;

  // 2. 备份（导出瞬间执行）
  let backup = { dir: '', files: [] as string[] };
  if (doBackup) {
    try {
      backup = await backupCodexFiles(codexDir);
      await logOp({
        op: 'backup', phase: 'ok', sessionId,
        message: `已备份 ${backup.files.length} 个 Codex JSONL 文件`,
        detail: { dir: backup.dir, count: backup.files.length },
      });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const report: ExportReport = {
        sourceSessionId: sessionId, ok: false,
        stats: { lines: 0, messages: 0, toolCalls: 0, bytes: 0 }, warnings: [],
        error: { code: 'BACKUP_FAILED', message: describeError('BACKUP_FAILED', { reason: msg }) },
      };
      await logOp({ op: 'backup', phase: 'fail', sessionId, message: report.error!.message });
      return { report, outFile: '', backupDir: '', backupFiles: [] };
    }
  }

  // 3. 转换
  let jsonl: string;
  let report: ExportReport;
  try {
    const session = readDshSessionFile(row.filePath);
    const r = dshToCodex({ header: session.header, events: session.events });
    jsonl = r.jsonl;
    report = r.report;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    report = {
      sourceSessionId: sessionId, ok: false,
      stats: { lines: 0, messages: 0, toolCalls: 0, bytes: 0 }, warnings: [],
      error: { code: 'CONVERT_FAILED', message: describeError('CONVERT_FAILED', { reason: msg }) },
    };
    await logOp({ op: 'export', phase: 'fail', sessionId, message: report.error!.message });
    return { report, outFile: '', backupDir: backup.dir, backupFiles: backup.files };
  }

  // 4. 写文件（命名对齐 Codex 的 rollout 约定）
  try {
    await fsp.mkdir(outDir, { recursive: true });
    const threadId = deriveThreadId(sessionId);
    // ★ Codex 要求 canonical rollout 文件名：rollout-<YYYY-MM-DDTHH-MM-SS>-<threadId>.jsonl
    //   不能带毫秒和 Z（否则 resume 时报 "does not have a canonical rollout filename"）。
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const fileName = `rollout-${stamp}-${threadId}.jsonl`;
    const outFile = path.join(outDir, fileName);
    await fsp.writeFile(outFile, jsonl, 'utf8');

    await logOp({
      op: 'export', phase: 'ok', sessionId,
      message: `导出成功：${report.stats.lines} 行 / ${report.stats.messages} 条消息 / ${report.stats.toolCalls} 次工具调用`,
      detail: { outFile, backupDir: backup.dir, backupFiles: backup.files.length },
    });

    return { report, outFile, backupDir: backup.dir, backupFiles: backup.files };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    report.ok = false;
    report.error = { code: 'EXPORT_WRITE_FAILED', message: describeError('EXPORT_WRITE_FAILED', { reason: msg }) };
    await logOp({ op: 'export', phase: 'fail', sessionId, message: report.error.message });
    return { report, outFile: '', backupDir: backup.dir, backupFiles: backup.files };
  }
}

/** 批量导出 */
export async function exportMany(
  sessionIds: string[],
  opts: { dshSessionsRoot?: string; codexSessionsDir?: string; doBackup?: boolean } = {},
): Promise<{
  results: ExportOneResult[];
  ok: number;
  failed: number;
  backupDir: string;
  outDir: string;
}> {
  if (sessionIds.length === 0) {
    throw new BridgeError('NO_SELECTION');
  }
  const results: ExportOneResult[] = [];
  // 备份只做一次（多个会话共享同一份备份快照）
  let first = true;
  for (const id of sessionIds) {
    const r = await exportOne(id, { ...opts, doBackup: opts.doBackup !== false && first });
    first = false;
    results.push(r);
  }
  const ok = results.filter((r) => r.report.ok).length;
  return {
    results,
    ok,
    failed: results.length - ok,
    backupDir: results[0]?.backupDir ?? '',
    outDir: exportDir(),
  };
}

function deriveThreadId(dshId: string): string {
  const m = dshId.match(/^session-codex-(.+)$/);
  return m ? m[1] : dshId.replace(/^session-/, '');
}

// ───────────────────────── WorkBuddy 导出 ─────────────────────────

export interface WbExportOneResult {
  sourceSessionId: string;
  ok: boolean;
  workbuddySessionId?: string;
  jsonlPath?: string;
  projectDir?: string;
  rows?: number;
  warnings: string[];
  error?: { code: string; message: string };
}

/**
 * 把 DSH 会话导入 WorkBuddy（直接写入 WorkBuddy 本地存储）。
 *
 * 与 Codex 导出的区别：
 *   - Codex：只写受控目录，用户手动复制（因为 Codex 有正在进行的会话，避免破坏）
 *   - WorkBuddy：直接写入（它用 sqlite 索引 + 独立项目目录，追加不影响现有会话）
 *   写入前同样会先做备份（由调用方统一处理）。
 */
export async function exportOneToWorkbuddy(
  sessionId: string,
  opts: { dshSessionsRoot?: string } = {},
): Promise<WbExportOneResult> {
  const dshRoot = opts.dshSessionsRoot ?? defaultDshSessionsRoot();

  await logOp({ op: 'export', phase: 'start', sessionId, message: `开始导入 WorkBuddy：${sessionId}` });

  if (!workbuddyAvailable()) {
    const message = '未检测到 WorkBuddy（缺少 workbuddy.db）。请先安装并运行一次 WorkBuddy。';
    await logOp({ op: 'export', phase: 'fail', sessionId, message });
    return { sourceSessionId: sessionId, ok: false, warnings: [], error: { code: 'UNSUPPORTED_ENV', message } };
  }

  // 定位会话（兼容带/不带 session- 前缀）
  const rows = await listDshSessions(dshRoot);
  const row = rows.find((r) => r.id === sessionId)
    ?? rows.find((r) => r.id === `session-${sessionId}`)
    ?? rows.find((r) => r.id.replace(/^session-/, '') === sessionId.replace(/^session-/, ''));
  if (!row) {
    const message = `未找到会话 ${sessionId}`;
    await logOp({ op: 'export', phase: 'fail', sessionId, message });
    return { sourceSessionId: sessionId, ok: false, warnings: [], error: { code: 'SCAN_FAILED', message } };
  }

  try {
    const session = readDshSessionFile(row.filePath);
    const w = await writeWorkbuddySession(session);
    await logOp({
      op: 'export', phase: 'ok', sessionId: row.id,
      message: `已导入 WorkBuddy：${w.rows} 条记录`,
      detail: { workbuddySessionId: w.sessionId, jsonlPath: w.jsonlPath, projectDir: w.projectDir },
    });
    return {
      sourceSessionId: row.id,
      ok: true,
      workbuddySessionId: w.sessionId,
      jsonlPath: w.jsonlPath,
      projectDir: w.projectDir,
      rows: w.rows,
      warnings: [],
    };
  } catch (e) {
    const message = e instanceof BridgeError
      ? describeError(e.code, e.detail ?? {})
      : String((e as Error)?.message ?? e);
    await logOp({ op: 'export', phase: 'fail', sessionId: row.id, message });
    return { sourceSessionId: row.id, ok: false, warnings: [], error: { code: 'DSH_WRITE_FAILED', message } };
  }
}

/** 批量导入 WorkBuddy */
export async function exportManyToWorkbuddy(
  sessionIds: string[],
  opts: { dshSessionsRoot?: string } = {},
): Promise<{ results: WbExportOneResult[]; ok: number; failed: number }> {
  if (sessionIds.length === 0) throw new BridgeError('NO_SELECTION');
  const results: WbExportOneResult[] = [];
  for (const id of sessionIds) {
    results.push(await exportOneToWorkbuddy(id, opts));
  }
  const ok = results.filter((r) => r.ok).length;
  return { results, ok, failed: results.length - ok };
}
