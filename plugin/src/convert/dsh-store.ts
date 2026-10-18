/**
 * convert/dsh-store.ts —— DSH v4 会话文件读写（多 zstd frame）
 *
 * ⚠️ 核心实测结论：单个 session.v4.jsonl.zstd 由 **多个独立 zstd frame 顺序追加** 组成。
 *    实测：4,334,982 字节 = 2,305 个 frame = 3,980 行事件。
 *    直接 zstdDecompressSync(整个文件) 只能得到第一帧（214 字节的 header）。
 *
 * 正确做法：
 *   读：扫描 28 B5 2F FD 魔数切帧 → 逐帧解压 → 拼接
 *   写：header 一帧 + 事件逐行一帧（与 DSH 原生增量写一致）
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import type { DshHeader, DshEvent, DshSession } from '../shared/types.js';
import { BridgeError } from '../shared/errors.js';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const SESSION_FILE = 'session.v4.jsonl.zstd';

/** 找到所有 zstd frame 起点 */
export function findFrameOffsets(buf: Buffer): number[] {
  const cuts: number[] = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
      cuts.push(i);
    }
  }
  return cuts;
}

/**
 * 读取 DSH v4 会话文件。
 * 容忍尾部中断帧（写入中断），跳过但记录告警。
 */
export function readDshSessionFile(filePath: string): DshSession & { warnings: string[] } {
  const buf = fs.readFileSync(filePath);
  const cuts = findFrameOffsets(buf);
  if (cuts.length === 0) {
    throw new BridgeError('FILE_CORRUPTED', undefined, { file: filePath });
  }
  const warnings: string[] = [];
  let text = '';
  for (let i = 0; i < cuts.length; i++) {
    const chunk = buf.subarray(cuts[i], cuts[i + 1] ?? buf.length);
    try {
      text += zlib.zstdDecompressSync(chunk).toString('utf8');
    } catch (e) {
      // 尾帧损坏通常是写入中断，可容忍；中间帧损坏则视为残缺
      if (i < cuts.length - 1) {
        warnings.push(`第 ${i + 1} 个数据帧损坏，已跳过（共 ${cuts.length} 帧）`);
      } else {
        warnings.push('最后一个数据帧不完整（可能是写入中断），已跳过');
      }
    }
  }

  const rows = text.split('\n').filter((s) => s.trim());
  if (rows.length === 0) {
    throw new BridgeError('FILE_CORRUPTED', undefined, { file: filePath });
  }

  let header: DshHeader | null = null;
  const events: DshEvent[] = [];
  for (let i = 0; i < rows.length; i++) {
    try {
      const o = JSON.parse(rows[i]);
      if (o.type === 'session' || (i === 0 && typeof o.version === 'number' && typeof o.id === 'string')) {
        // header 行：物理层没有 type 字段时按 header 处理
        header = normalizeHeader(o);
      } else {
        events.push(o as DshEvent);
      }
    } catch {
      warnings.push(`第 ${i + 1} 行 JSON 损坏，已跳过`);
    }
  }

  if (!header) throw new BridgeError('FILE_CORRUPTED', undefined, { file: filePath });
  return { header, events, warnings };
}

/** 兼容两种 header 形态：{type:'session',...} 或纯 {version,id,...} */
function normalizeHeader(o: any): DshHeader {
  return {
    version: 4,
    id: String(o.id),
    createdAt: Number(o.createdAt) || Date.now(),
    isSeeded: Boolean(o.isSeeded),
    delegationDepth: Number(o.delegationDepth) || 0,
    ...(o.cwd ? { cwd: String(o.cwd) } : {}),
    ...(o.parentSession ? { parentSession: String(o.parentSession) } : {}),
    ...(o.origin ? { origin: 'subagent' as const } : {}),
    ...(o.agentPreset ? { agentPreset: String(o.agentPreset) } : {}),
  };
}

/**
 * 写入 DSH v4 会话：header 一帧，每个事件一帧。
 * ★ 强制 seq 稠密（P0 实测：非稠密会被 "is not dense" 拒绝）。
 */
export async function writeDshSessionFile(session: DshSession, targetDir: string): Promise<string> {
  await fsp.mkdir(targetDir, { recursive: true });
  const filePath = path.join(targetDir, SESSION_FILE);

  // 稠密性强制修正
  const events = session.events.map((e, i) => ({ ...e, seq: i }));

  // ★ 物理层 header 首行必须有 type:"session"（实测 HEADER_REQUIRED_KEYS 含 type）。
  // 缺 type 会导致 DSH 的 isHeaderLine 判否，把首行当事件行，整个会话被静默跳过、不显示。
  const headerLine = JSON.stringify({ type: 'session', ...session.header }) + '\n';
  const frames: Buffer[] = [zlib.zstdCompressSync(Buffer.from(headerLine, 'utf8'))];
  for (const e of events) {
    frames.push(zlib.zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8')));
  }

  // 原子写：先写临时文件再 rename，避免半写状态
  const tmp = filePath + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, Buffer.concat(frames));
  await fsp.rename(tmp, filePath);
  return filePath;
}

/** 校验事件是否稠密（导入前自检） */
export function assertDense(events: DshEvent[]): void {
  for (let i = 0; i < events.length; i++) {
    if (events[i].seq !== i) {
      throw new BridgeError('CONVERT_FAILED', '事件序号不连续', {
        reason: `第 ${i} 个事件的 seq 为 ${events[i].seq}，应为 ${i}`,
      });
    }
  }
}

/** 列出某个 DSH home 下的全部会话（用于导出列表） */
export async function listDshSessions(sessionsRoot: string): Promise<Array<{
  id: string; projectDir: string; filePath: string; sizeBytes: number; mtime: number;
}>> {
  const out: Array<{ id: string; projectDir: string; filePath: string; sizeBytes: number; mtime: number }> = [];
  let projects: string[] = [];
  try {
    projects = await fsp.readdir(sessionsRoot);
  } catch {
    return out;
  }
  for (const proj of projects) {
    const projDir = path.join(sessionsRoot, proj);
    let entries: string[] = [];
    try { entries = await fsp.readdir(projDir); } catch { continue; }
    for (const ent of entries) {
      if (!ent.startsWith('session-')) continue;
      const f = path.join(projDir, ent, SESSION_FILE);
      try {
        const st = await fsp.stat(f);
        out.push({ id: ent, projectDir: projDir, filePath: f, sizeBytes: st.size, mtime: st.mtimeMs });
      } catch { /* 跳过 */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
