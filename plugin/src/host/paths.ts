/**
 * host/paths.ts —— 路径探测与解析
 *
 * 桌面端需要自动定位 Codex 会话目录与 DSH home。
 * 路径规则来自实测：
 *   Codex:  %USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl[.zst]
 *   DSH:    %USERPROFILE%\.dsh\sessions\<project>\<session-id>\session.v4.jsonl.zstd
 */
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';

/** 默认 Codex 根目录 */
export function defaultCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

/** 默认 Codex 会话目录 */
export function defaultCodexSessionsDir(): string {
  return path.join(defaultCodexHome(), 'sessions');
}

/**
 * Codex 官方会话索引（权威的 thread 列表 + thread_name 标题）。
 * 实测：session_index.jsonl 记录 41 个 thread，而 rollout 文件有 140 个（含子代理线程 + turn 分片）。
 */
export function codexSessionIndexFile(): string {
  return path.join(defaultCodexHome(), 'session_index.jsonl');
}

/**
 * Codex 归档会话目录（被归档的 rollout 也在这里）。
 * 实测：session_index 里的 thread 有 23 个只在 archived_sessions 里。
 */
export function codexArchivedSessionsDir(): string {
  return path.join(defaultCodexHome(), 'archived_sessions');
}

/**
 * ★ DSH 会话目录的 projectKey 编码（逐字复刻 dsh-session-persistence-jsonl 的实现）。
 * 会话文件必须写到 sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.v4.jsonl.zstd，
 * 否则 DSH 的派生索引不会发现它、聊天列表不会显示。
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** 默认 DSH home */
export function defaultDshHome(): string {
  return process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
}

/** DSH 会话根目录 */
export function defaultDshSessionsRoot(): string {
  return path.join(defaultDshHome(), 'sessions');
}

/** 插件输出目录（导出 JSONL、备份、日志） */
export function bridgeWorkDir(): string {
  return path.join(defaultDshHome(), 'codex-bridge');
}

/** 导出文件目录 */
export function exportDir(): string {
  return path.join(bridgeWorkDir(), 'export');
}

/** 备份目录（按时间戳分子目录） */
export function backupDir(stamp: string): string {
  return path.join(bridgeWorkDir(), 'backup', stamp);
}

/** 操作日志文件 */
export function opLogFile(): string {
  return path.join(bridgeWorkDir(), 'operations.ndjson');
}

/** 判断目录是否存在且可读 */
export async function dirAccessible(p: string): Promise<{ ok: boolean; reason?: 'ENOENT' | 'EACCES' | 'OTHER' }> {
  try {
    const st = await fsp.stat(p);
    if (!st.isDirectory()) return { ok: false, reason: 'OTHER' };
    await fsp.access(p, 0x4 /* R_OK */);
    return { ok: true };
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { ok: false, reason: 'ENOENT' };
    if (e?.code === 'EACCES' || e?.code === 'EPERM') return { ok: false, reason: 'EACCES' };
    return { ok: false, reason: 'OTHER' };
  }
}

/** 递归列出所有 rollout 文件 */
export async function listRolloutFiles(sessionsDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (/^rollout-.*\.jsonl(\.zst)?$/.test(ent.name)) {
        out.push(full);
      }
    }
  }
  await walk(sessionsDir);
  return out;
}

/** DSH workspace.json 的路径 */
export function workspaceRegistryFile(): string {
  return path.join(defaultDshHome(), 'storages', 'workspace.json');
}

/** 一个可选的导入目标工作区 */
export interface WorkspaceInfo {
  path: string;
  title: string;
  sessionCount: number;
}

/**
 * 列出 DSH 现有工作区（导入时供用户选择目标）。
 * 从 storages/workspace.json 读取 tables.workspaces。
 */
export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  try {
    const raw = await fsp.readFile(workspaceRegistryFile(), 'utf8');
    const data = JSON.parse(raw);
    const tables = data?.tables?.workspaces ?? {};
    const out: WorkspaceInfo[] = [];
    for (const key of Object.keys(tables)) {
      const ws = tables[key];
      if (ws && typeof ws.path === 'string') {
        out.push({
          path: ws.path,
          title: typeof ws.title === 'string' ? ws.title : path.basename(ws.path),
          sessionCount: Array.isArray(ws.sessionIds) ? ws.sessionIds.length : 0,
        });
      }
    }
    return out.sort((a, b) => b.sessionCount - a.sessionCount);
  } catch {
    return [];
  }
}
