/**
 * convert/codex-reader.ts —— 读取 Codex rollout（明文 .jsonl / 压缩 .jsonl.zst）
 *
 * 实测要点：
 *   1. Codex 存在两种扩展名：.jsonl（明文）与 .jsonl.zst（单帧 zstd）
 *   2. 需要流式逐行读取，单个 105 MB 的文件不能整体 JSON.parse
 *   3. 单行损坏不应拖垮整个会话（按行隔离）
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { stat } from 'node:fs/promises';
import zlib from 'node:zlib';
import type { CodexLine, CodexSessionMeta, CodexSessionSummary } from '../shared/types.js';
import { BridgeError } from '../shared/errors.js';

/** 单文件默认上限（256 MB），超过直接拒绝，避免 OOM */
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/**
 * 判断一段 Buffer 是否以 zstd magic 开头。
 * .jsonl.zst 是单帧；.jsonl 是纯文本。
 */
function isZstd(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  return ZSTD_MAGIC.every((b, i) => buf[i] === b);
}

/** 解压 zstd；支持多帧（Codex 的 .zst 实测为单帧，但防御性支持多帧） */
export function decompressZstd(buf: Buffer): Buffer {
  try {
    const out = zlib.zstdDecompressSync(buf);
    return out;
  } catch {
    // 多帧：按魔数切分后逐帧解压
    const cuts: number[] = [];
    for (let i = 0; i + 3 < buf.length; i++) {
      if (ZSTD_MAGIC.every((b, k) => buf[i + k] === b)) cuts.push(i);
    }
    if (cuts.length === 0) {
      throw new BridgeError('FILE_CORRUPTED', undefined, { file: '(zstd)' });
    }
    const parts: Buffer[] = [];
    let failed = 0;
    for (let i = 0; i < cuts.length; i++) {
      const chunk = buf.subarray(cuts[i], cuts[i + 1] ?? buf.length);
      try { parts.push(zlib.zstdDecompressSync(chunk)); }
      catch { failed++; } // 中断的尾帧可容忍
    }
    if (parts.length === 0) {
      throw new BridgeError('FILE_CORRUPTED', undefined, { file: '(zstd)' });
    }
    return Buffer.concat(parts);
  }
}

/** 把文件内容解码为文本行（自动识别 zstd / 明文） */
export function decodeRolloutBuffer(buf: Buffer): string {
  const raw = isZstd(buf) ? decompressZstd(buf) : buf;
  return raw.toString('utf8');
}

/**
 * 逐行解析 rollout 文本。
 * @returns 解析成功的行 + 解析失败的行号列表（不中断整体）
 */
export function parseRolloutText(
  text: string,
  file = '(unknown)',
): { lines: CodexLine[]; badLines: number[] } {
  const lines: CodexLine[] = [];
  const badLines: number[] = [];
  const arr = text.split('\n');
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i].trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object' && typeof o.type === 'string') lines.push(o as CodexLine);
      else badLines.push(i + 1);
    } catch {
      badLines.push(i + 1);
    }
  }
  return { lines, badLines };
}

/** 读取整个 rollout（带大小保护） */
export async function readRollout(
  filePath: string,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<{ lines: CodexLine[]; badLines: number[]; sizeBytes: number }> {
  const st = await stat(filePath);
  if (st.size > maxBytes) {
    throw new BridgeError('FILE_TOO_LARGE', undefined, {
      file: filePath, size: st.size, limit: maxBytes,
    });
  }
  // 小文件直接读；大文件用流式拼接，避免一次性 Buffer 翻倍
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(filePath);
    rs.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : (c as Buffer)));
    rs.on('end', () => resolve());
    rs.on('error', (e) => reject(e));
  });
  const buf = Buffer.concat(chunks);
  const text = decodeRolloutBuffer(buf);
  const { lines, badLines } = parseRolloutText(text, filePath);
  return { lines, badLines, sizeBytes: st.size };
}

/** 从 rollout 行中提取会话元数据 */
export function extractMeta(lines: CodexLine[]): CodexSessionMeta | null {
  const row = lines.find((l) => l.type === 'session_meta');
  if (!row) return null;
  return row.payload as CodexSessionMeta;
}

/** 从 rollout 行统计出列表展示所需的摘要信息 */
export function summarize(
  lines: CodexLine[],
  meta: CodexSessionMeta,
  filePath: string,
  sizeBytes: number,
): CodexSessionSummary {
  const isSubagent = meta.thread_source === 'subagent';
  const spawn = typeof meta.source === 'object' && meta.source !== null
    ? (meta.source as any)?.subagent?.thread_spawn : undefined;

  let turnCount = 0;
  let messageCount = 0;
  let firstUserText = '';

  for (const l of lines) {
    if (l.type === 'event_msg' && l.payload?.type === 'task_started') turnCount++;
    if (l.type === 'response_item' && l.payload?.type === 'message') {
      messageCount++;
      const role = l.payload.role;
      const text = (l.payload.content ?? [])
        .filter((c: any) => typeof c.text === 'string')
        .map((c: any) => c.text).join(' ');
      if (!firstUserText && role === 'user' && text) {
        // 跳过被注入的 AGENTS.md / environment_context 块
        const cleaned = text
          .replace(/# AGENTS\.md instructions[\s\S]*?<\/INSTRUCTIONS>/g, '')
          .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
          .trim();
        if (cleaned) firstUserText = cleaned;
      }
    }
  }

  const created = Date.parse(meta.timestamp ?? '') || 0;
  const last = lines[lines.length - 1];
  const updated = Date.parse(last?.timestamp ?? '') || created;

  return {
    id: meta.id,                                   // ★ 自身线程 id（不是 session_id）
    filePath,
    title: firstUserText.slice(0, 80) || '(无标题)',
    cwd: meta.cwd ?? '',
    createdAt: created,
    updatedAt: updated,
    sizeBytes,
    compressed: filePath.endsWith('.zst'),
    isSubagent,
    parentThreadId: meta.parent_thread_id ?? spawn?.parent_thread_id,
    agentPath: meta.agent_path ?? spawn?.agent_path,
    agentNickname: meta.agent_nickname ?? spawn?.agent_nickname,
    turnCount,
    messageCount,
  };
}

/** session_index.jsonl 的一条记录 */
export interface CodexSessionIndexEntry {
  id: string;
  thread_name: string;
  updated_at: string;
}

/**
 * 读取 Codex 官方会话索引（session_index.jsonl）。
 * 这是「会话（thread）」的权威列表——rollout 文件里还包含子代理线程与 turn 分片，
 * 数量会虚高；索引里的 thread_name 是 Codex 维护的标题，比从内容猜可靠。
 */
export async function readSessionIndex(indexFile: string): Promise<CodexSessionIndexEntry[]> {
  let text: string;
  try {
    text = await import('node:fs/promises').then((fsp) => fsp.readFile(indexFile, 'utf8'));
  } catch {
    return [];
  }
  const out: CodexSessionIndexEntry[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && typeof o.id === 'string') {
        out.push({
          id: o.id,
          thread_name: typeof o.thread_name === 'string' ? o.thread_name : '',
          updated_at: typeof o.updated_at === 'string' ? o.updated_at : '',
        });
      }
    } catch { /* 跳过坏行 */ }
  }
  return out;
}

/**
 * 从 rollout 文件名解析 thread id。
 * 命名规则：rollout-<ISO时间>-<threadId>[_<turnId>].jsonl[.zst]
 * 文件名的第一段 uuid 是 thread id；带第二段 uuid 的是同一个 thread 的 turn 分片。
 */
export function threadIdFromFileName(filePath: string): string | null {
  const name = filePath.split(/[\\/]/).pop() ?? '';
  const m = name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  return m ? m[0] : null;
}
