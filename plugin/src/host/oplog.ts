/**
 * host/oplog.ts —— 关键操作日志（导入 / 导出 / 备份）
 *
 * 设计要点：
 *  - NDJSON 追加写，天然支持并发与崩溃恢复
 *  - 只记录元数据，**绝不记录消息正文**（避免敏感信息落盘）
 *  - 按大小轮转，避免无限增长
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { OpLogEntry } from '../shared/types.js';
import { opLogFile, bridgeWorkDir } from './paths.js';

const MAX_LOG_BYTES = 4 * 1024 * 1024; // 4 MB 轮转

let dirReady = false;
async function ensureDir(): Promise<void> {
  if (dirReady) return;
  await fsp.mkdir(path.dirname(opLogFile()), { recursive: true }).catch(() => {});
  dirReady = true;
}

async function rotateIfNeeded(): Promise<void> {
  try {
    const st = await fsp.stat(opLogFile());
    if (st.size > MAX_LOG_BYTES) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await fsp.rename(opLogFile(), path.join(bridgeWorkDir(), `operations-${stamp}.ndjson`));
    }
  } catch { /* 文件不存在则无需轮转 */ }
}

let seq = 0;

/** 写一条操作日志 */
export async function logOp(entry: Omit<OpLogEntry, 'id' | 'at'>): Promise<void> {
  try {
    await ensureDir();
    await rotateIfNeeded();
    const full: OpLogEntry = {
      id: `op-${Date.now().toString(36)}-${(seq++).toString(36)}`,
      at: Date.now(),
      ...entry,
    };
    await fsp.appendFile(opLogFile(), JSON.stringify(full) + '\n', 'utf8');
  } catch {
    // 日志失败绝不影响主流程
  }
}

/** 读取最近 N 条日志（用于 UI 展示） */
export async function readRecentLogs(limit = 100): Promise<OpLogEntry[]> {
  try {
    const text = await fsp.readFile(opLogFile(), 'utf8');
    const rows = text.split('\n').filter((s) => s.trim());
    const out: OpLogEntry[] = [];
    for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
      try { out.push(JSON.parse(rows[i])); } catch { /* 跳过坏行 */ }
    }
    return out;
  } catch {
    return [];
  }
}
