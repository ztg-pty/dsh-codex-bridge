/**
 * host/wb-store.ts —— 把会话写入 WorkBuddy 本地存储
 *
 * ★ 实测机制（WorkBuddy AI v5.8.4，2026-10）：
 *   会话由三部分组成：
 *     1. `workbuddy.db` 的 `sessions` 表 —— 元数据（必填 cwd/user_id/created_at/updated_at）
 *     2. `workbuddy.db` 的 `workspaces` 表 —— 工作区列表（path 为 Windows 反斜杠形式）
 *     3. `projects/<cwd编码>/<sessionId>.jsonl` —— 会话内容
 *   cwd 编码规则：`D:/UE Save/x` → `d-UE Save-x`（盘符小写，冒号与斜杠都变 `-`）
 *
 * ⚠️ 写入顺序至关重要：必须先写数据库、再写 jsonl 文件。
 *    反过来 WorkBuddy 会把无主项目目录当成垃圾清理掉（实测）。
 */
import fs from 'node:fs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { BridgeError } from '../shared/errors.js';
import { dshToWorkbuddy, type WbRow } from '../convert/dsh2wb.js';
import type { DshSession } from '../shared/types.js';

/** WorkBuddy 本地根目录（Electron userData 的上一层，实测路径） */
export function defaultWorkbuddyHome(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return path.join(home, '.workbuddy-ai');
}

/** WorkBuddy 数据库路径 */
export function workbuddyDbFile(): string {
  return path.join(defaultWorkbuddyHome(), 'workbuddy.db');
}

/** 会话项目目录（cwd 编码后的目录名） */
export function workbuddyProjectDir(cwdWin: string): string {
  const posix = cwdWin.replace(/\\/g, '/');
  const encoded = posix
    .replace(/^([A-Za-z]):/, (_, d: string) => d.toLowerCase())
    .replace(/[/:]/g, '-');
  return path.join(defaultWorkbuddyHome(), 'projects', encoded);
}

/** 检测 WorkBuddy 是否已安装（数据库存在即可） */
export function workbuddyAvailable(): boolean {
  try {
    return fs.existsSync(workbuddyDbFile());
  } catch {
    return false;
  }
}

/** 读取 WorkBuddy 的 user_id（从现有会话取，导入的会话需要归属同一用户） */
function readUserId(db: any): string {
  const row = db.prepare('SELECT user_id FROM sessions LIMIT 1').get();
  if (row?.user_id) return String(row.user_id);
  throw new BridgeError('UNSUPPORTED_ENV', undefined, {
    reason: 'WorkBuddy 中没有任何会话，无法确定用户 ID。请先在 WorkBuddy 里创建并打开一个会话，再重试。',
  });
}

export interface WbWriteResult {
  ok: boolean;
  sessionId: string;
  jsonlPath: string;
  projectDir: string;
  rows: number;
  error?: string;
}

/**
 * 把一个 DSH 会话导入 WorkBuddy。
 * @param session DSH 会话
 * @param opts.title 覆盖标题；opts.cwd 覆盖工作目录
 */
export async function writeWorkbuddySession(
  session: DshSession,
  opts: { title?: string; cwd?: string } = {},
): Promise<WbWriteResult> {
  const dbFile = workbuddyDbFile();
  if (!fs.existsSync(dbFile)) {
    throw new BridgeError('UNSUPPORTED_ENV', undefined, {
      reason: `未找到 WorkBuddy 数据库：${dbFile}（请确认 WorkBuddy 已安装并运行过）`,
    });
  }

  let DatabaseSync: any;
  try {
    ({ DatabaseSync } = await import('node:sqlite' as any));
  } catch {
    throw new BridgeError('UNSUPPORTED_ENV', undefined, {
      reason: '当前 Node 运行时不支持 node:sqlite，无法写入 WorkBuddy',
    });
  }

  const sessionId = crypto.randomUUID();
  const cwdWin = (opts.cwd ?? session.header.cwd ?? process.cwd()).replace(/\//g, '\\');
  const cwdPosix = cwdWin.replace(/\\/g, '/');
  const createdMs = session.header.createdAt || Date.now();
  const now = Date.now();

  // 先转换（失败就不要动数据库）
  const converted = dshToWorkbuddy(session, {
    sessionId,
    cwd: cwdWin,
    title: opts.title,
  });
  const title = String(
    (converted.rows.find((r) => r.type === 'ai-title') as any)?.aiTitle ?? '导入会话',
  ).slice(0, 200);

  // ── 1. 先写数据库（sessions + workspaces）──
  const db = new DatabaseSync(dbFile);
  try {
    const userId = readUserId(db);
    db.prepare('INSERT OR REPLACE INTO workspaces (path, last_opened_at) VALUES (?,?)').run(cwdWin, now);
    db.prepare(`
      INSERT INTO sessions (
        id, cwd, user_id, title, status, created_at, updated_at, last_activity_at,
        is_playground, source_mode, mode, model, permission_mode, use_sandbox_cli,
        context_window, thought_level, transport
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      sessionId, cwdPosix, userId, title,
      'completed', createdMs, now, now,
      1, 'craft', 'craft', 'deepseek-v4.1-flash', 'bypassPermissions', 1,
      1000000, 'high', 'local',
    );
  } catch (e) {
    db.close();
    throw new BridgeError('DSH_WRITE_FAILED', undefined, {
      reason: `写入 WorkBuddy 数据库失败：${String((e as Error)?.message ?? e)}`,
    });
  } finally {
    try { db.close(); } catch { /* 已关闭 */ }
  }

  // ── 2. 再写 jsonl（顺序关键：数据库先行，否则目录会被清理）──
  const projectDir = workbuddyProjectDir(cwdWin);
  await fsp.mkdir(projectDir, { recursive: true });
  const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
  const text = converted.rows.map((r: WbRow) => JSON.stringify(r)).join('\n') + '\n';
  const tmp = jsonlPath + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, jsonlPath);

  return {
    ok: true,
    sessionId,
    jsonlPath,
    projectDir,
    rows: converted.rows.length,
  };
}

/** 列出 WorkBuddy 里现有的会话（用于 UI 展示/去重） */
export async function listWorkbuddySessions(): Promise<Array<{
  id: string; title: string; cwd: string; updatedAt: number; model: string;
}>> {
  const dbFile = workbuddyDbFile();
  if (!fs.existsSync(dbFile)) return [];
  let DatabaseSync: any;
  try {
    ({ DatabaseSync } = await import('node:sqlite' as any));
  } catch {
    return [];
  }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const rows = db.prepare(
      'SELECT id, title, cwd, updated_at, model FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC',
    ).all();
    return rows.map((r: any) => ({
      id: String(r.id),
      title: String(r.title ?? ''),
      cwd: String(r.cwd ?? ''),
      updatedAt: Number(r.updated_at ?? 0),
      model: String(r.model ?? ''),
    }));
  } catch {
    return [];
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}
