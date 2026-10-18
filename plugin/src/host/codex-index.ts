/**
 * host/codex-index.ts —— 把导出的 rollout 注册进 Codex 索引
 *
 * ★ 实测机制（本机 Codex 0.16x）：
 *   Codex 的会话列表【不是扫描 sessions 目录】，而是读两个索引：
 *     1. `state_5.sqlite` 的 `threads` 表 —— 桌面端会话列表的主数据源
 *        关键字段：id / rollout_path / cwd / title / created_at_ms / updated_at_ms ...
 *        rollout_path 是 Windows 长路径格式：`\\?\F:\...\rollout-xxx.jsonl`
 *     2. `session_index.jsonl` —— 轻量索引（id / thread_name / updated_at），CLI resume 用
 *
 *   因此导出的 JSONL 复制进 Codex 目录后，必须在 threads 表补一行，Codex 才会显示。
 *   本模块就是做这件事；写入前会检查 id 是否已存在（存在则更新路径与时间）。
 *
 * ⚠️ 风险：直接写 Codex 的 sqlite。调用方应先让用户确认、并建议备份数据库。
 *    使用 WAL 模式时并发写通常安全，但仍建议在 Codex 未进行关键操作时执行。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { BridgeError } from '../shared/errors.js';
import { defaultCodexHome } from './paths.js';

export interface RegisterResult {
  /** 已注册（新插入或更新）的 thread */
  registered: Array<{ id: string; title: string; rolloutPath: string }>;
  /** 已在索引中、无需处理 */
  skipped: Array<{ id: string; reason: string }>;
  /** 处理失败 */
  failed: Array<{ file: string; reason: string }>;
  dbPath: string;
  indexPath: string;
}

/** Windows 长路径前缀（Codex 内部统一用这种拼写） */
function longPath(p: string): string {
  let real = p;
  try { real = fs.realpathSync.native(p); } catch { /* 文件不在时用原路径 */ }
  return real.startsWith('\\\\?\\') ? real : '\\\\?\\' + real;
}

/**
 * 读取 rollout 文本（支持 .jsonl 明文与 .jsonl.zst 压缩）。
 * Codex 有些旧会话是 zstd 压缩的，读明文会失败。
 */
function readRolloutText(file: string): string | null {
  try {
    const buf = fs.readFileSync(file);
    const isZstd = buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd;
    if (!isZstd) return buf.toString('utf8');
    return zlib.zstdDecompressSync(buf).toString('utf8');
  } catch {
    return null;
  }
}

/** 从 rollout 首行读 session_meta */
function readMeta(file: string): any | null {
  try {
    const text = readRolloutText(file);
    if (text === null) return null;
    const firstLine = text.split('\n', 1)[0];
    const row = JSON.parse(firstLine);
    if (row?.type !== 'session_meta') return null;
    return row.payload;
  } catch {
    return null;
  }
}

/** 统计 rollout 里的用户消息数 + 取首条用户文本 */
function scanUserMessages(file: string): { count: number; first: string } {
  let count = 0;
  let first = '';
  try {
    const text = readRolloutText(file);
    if (text === null) return { count, first };
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      // 快速跳过明显无关的行，减少 JSON.parse 次数
      if (!line.includes('"role":"user"')) continue;
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'response_item' && o.payload?.type === 'message' && o.payload.role === 'user') {
        count++;
        if (!first) {
          const t = (o.payload.content ?? [])
            .filter((c: any) => typeof c?.text === 'string')
            .map((c: any) => c.text).join(' ');
          const cleaned = t
            .replace(/# AGENTS\.md instructions[\s\S]*?<\/INSTRUCTIONS>/g, '')
            .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
            .trim();
          if (cleaned) first = cleaned.slice(0, 500);
        }
      }
    }
  } catch { /* 读取失败按空处理 */ }
  return { count, first };
}

/**
 * 把一批 rollout 文件注册进 Codex 索引。
 * @param files rollout 绝对路径列表
 */
export async function registerToCodex(files: string[]): Promise<RegisterResult> {
  const codexHome = defaultCodexHome();
  const dbPath = path.join(codexHome, 'state_5.sqlite');
  const indexPath = path.join(codexHome, 'session_index.jsonl');

  if (!fs.existsSync(dbPath)) {
    throw new BridgeError('SCAN_FAILED', undefined, {
      reason: `未找到 Codex 索引数据库：${dbPath}（请确认 Codex 已安装并运行过）`,
    });
  }

  // 动态加载 node:sqlite（Node 22+ 内置，DSH 运行时是 Node 24）
  let DatabaseSync: any;
  try {
    ({ DatabaseSync } = await import('node:sqlite' as any));
  } catch {
    throw new BridgeError('UNSUPPORTED_ENV', undefined, {
      reason: '当前 Node 运行时不支持 node:sqlite，无法写 Codex 索引',
    });
  }

  const result: RegisterResult = {
    registered: [], skipped: [], failed: [], dbPath, indexPath,
  };

  const db = new DatabaseSync(dbPath);
  try {
    const selectById = db.prepare('SELECT id FROM threads WHERE id = ?');
    const insert = db.prepare(`
      INSERT INTO threads (
        id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
        sandbox_policy, approval_mode, tokens_used, has_user_event, archived, archived_at,
        git_sha, git_branch, git_origin_url, cli_version, first_user_message,
        agent_nickname, agent_role, memory_mode, model, reasoning_effort, agent_path,
        created_at_ms, updated_at_ms, thread_source, preview, recency_at, recency_at_ms,
        history_mode, name, is_pinned, originator
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const update = db.prepare(
      'UPDATE threads SET rollout_path=?, updated_at=?, updated_at_ms=?, recency_at=?, recency_at_ms=? WHERE id=?',
    );

    for (const file of files) {
      const meta = readMeta(file);
      if (!meta || typeof meta.id !== 'string') {
        result.failed.push({ file, reason: '首行不是合法的 session_meta（缺 id）' });
        continue;
      }
      const threadId: string = meta.id;
      if (selectById.get(threadId)) {
        result.skipped.push({ id: threadId, reason: '索引中已存在' });
        continue;
      }

      const { count, first } = scanUserMessages(file);
      const createdMs = Date.parse(meta.timestamp) || fs.statSync(file).mtimeMs || Date.now();
      const updatedMs = fs.statSync(file).mtimeMs || createdMs;
      const createdS = Math.floor(createdMs / 1000);
      const updatedS = Math.floor(updatedMs / 1000);
      const title = (first || '(导入会话)').slice(0, 120);
      const rp = longPath(file);
      const cwd = meta.cwd ? longPath(meta.cwd) : longPath(process.cwd());

      try {
        insert.run(
          threadId, rp, createdS, updatedS,
          'vscode', meta.model_provider || 'openai', cwd, title,
          '{"type":"disabled"}', 'never',
          0, count > 0 ? 1 : 0, 0, null,
          meta.git?.commit_hash ?? null, meta.git?.branch ?? null, null,
          meta.cli_version || '0.162.0', first,
          null, null, 'enabled', null, null, null,
          Math.floor(createdMs), Math.floor(updatedMs),
          'user', first.slice(0, 200), updatedS, Math.floor(updatedMs),
          'paginated', title, 0, meta.originator || 'DeepSeek Harness',
        );
        result.registered.push({ id: threadId, title, rolloutPath: rp });
      } catch (e) {
        // 已存在但 SELECT 没命中（并发）→ 退回更新
        try {
          update.run(rp, updatedS, Math.floor(updatedMs), updatedS, Math.floor(updatedMs), threadId);
          result.registered.push({ id: threadId, title, rolloutPath: rp });
        } catch (e2) {
          result.failed.push({ file, reason: String((e2 as Error)?.message ?? e2) });
        }
      }
    }
  } finally {
    db.close();
  }

  // 同步 session_index.jsonl（CLI resume 用；失败不影响桌面列表）
  try {
    const existing = new Set<string>();
    if (fs.existsSync(indexPath)) {
      for (const line of fs.readFileSync(indexPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { existing.add(JSON.parse(line).id); } catch { /* 跳过坏行 */ }
      }
    }
    const append: string[] = [];
    for (const r of result.registered) {
      if (existing.has(r.id)) continue;
      append.push(JSON.stringify({
        id: r.id,
        thread_name: r.title,
        updated_at: new Date().toISOString(),
      }));
    }
    if (append.length > 0) {
      fs.appendFileSync(indexPath, append.join('\n') + '\n', 'utf8');
    }
  } catch { /* 索引追加失败不影响主流程 */ }

  return result;
}
