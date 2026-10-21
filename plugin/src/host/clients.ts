/**
 * host/clients.ts —— 客户端发现与能力探测
 *
 * ★ 多机部署关键：不同机器安装的客户端不同，必须能「探测到什么用什么」，
 *   而不是假设五端都存在。
 *
 * 每个客户端探测分两级：
 *   1. 存储存在性（目录/数据库文件是否在）
 *   2. 可读写性（能否实际读取一条会话 —— 只在真正操作时检查，探测阶段不读内容）
 *
 * 所有路径都从 os.homedir() 与环境变量推导，无硬编码。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type ClientKind = 'dsh' | 'codex' | 'zcode' | 'claude-code' | 'workbuddy';

export interface ClientStatus {
  kind: ClientKind;
  /** 展示名 */
  label: string;
  /** 存储根目录（已解析为绝对路径） */
  home: string;
  /** 是否检测到（存储存在） */
  detected: boolean;
  /** 是否支持读取（本端能解析其格式） */
  canRead: boolean;
  /** 是否支持写入 */
  canWrite: boolean;
  /** 会话数量（探测阶段粗略统计，失败为 undefined） */
  sessionCount?: number;
  /** 不可用原因（中文） */
  reason?: string;
  /** 平台限制说明 */
  platformNote?: string;
}

function home(): string {
  return os.homedir();
}

/** 环境变量覆盖（便于测试与自定义安装位置） */
function envHome(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v ? v : path.join(home(), fallback);
}

/** DSH 根目录 */
export function dshHome(): string {
  return envHome('DSH_HOME', '.dsh');
}

/** Codex 根目录 */
export function codexHome(): string {
  return envHome('CODEX_HOME', '.codex');
}

/** Zcode 根目录 */
export function zcodeHome(): string {
  return envHome('ZCODE_HOME', '.zcode');
}

/** Claude Code 根目录 */
export function claudeCodeHome(): string {
  return envHome('CLAUDE_HOME', '.claude');
}

/** WorkBuddy 根目录 */
export function workbuddyHome(): string {
  return envHome('WORKBUDDY_HOME', '.workbuddy-ai');
}

/** 统计目录下的文件数（浅层，失败返回 undefined） */
function countFiles(dir: string, predicate: (name: string) => boolean): number | undefined {
  let n = 0;
  let ok = false;
  try {
    const walk = (d: string) => {
      const ents = fs.readdirSync(d, { withFileTypes: true });
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          // 限制递归深度，避免大目录卡住探测
          if (d.split(path.sep).length - dir.split(path.sep).length < 4) walk(p);
        } else if (predicate(e.name)) n++;
      }
      ok = true;
    };
    walk(dir);
  } catch {
    return undefined;
  }
  return ok ? n : undefined;
}

/** 探测单个客户端 */
export function probeClient(kind: ClientKind): ClientStatus {
  switch (kind) {
    case 'dsh': {
      const root = dshHome();
      const sessions = path.join(root, 'sessions');
      const detected = fs.existsSync(sessions);
      return {
        kind, label: 'DeepSeek Harness', home: root, detected,
        canRead: detected, canWrite: detected,
        sessionCount: detected
          ? countFiles(sessions, (n) => n === 'session.v4.jsonl.zstd')
          : undefined,
        ...(detected ? {} : { reason: `未找到 DSH 会话目录：${sessions}` }),
      };
    }
    case 'codex': {
      const root = codexHome();
      const sessions = path.join(root, 'sessions');
      const db = path.join(root, 'state_5.sqlite');
      const detected = fs.existsSync(sessions);
      return {
        kind, label: 'Codex', home: root, detected,
        canRead: detected,
        canWrite: detected && fs.existsSync(db),
        sessionCount: detected
          ? countFiles(sessions, (n) => /^rollout-.*\.jsonl(\.zst)?$/.test(n))
          : undefined,
        ...(detected ? {} : { reason: `未找到 Codex 会话目录：${sessions}` }),
        ...(detected && !fs.existsSync(db) ? { reason: '未找到 state_5.sqlite，只能读取不能写入' } : {}),
      };
    }
    case 'zcode': {
      const root = zcodeHome();
      const db = path.join(root, 'cli', 'db', 'db.sqlite');
      const detected = fs.existsSync(db);
      let sessionCount: number | undefined;
      if (detected) {
        try {
          // 用只读方式粗查（node:sqlite 是同步 API，这里避免在探测阶段引入复杂度）
          sessionCount = undefined;
        } catch { /* 忽略 */ }
      }
      return {
        kind, label: 'Zcode', home: root, detected,
        canRead: detected, canWrite: detected,
        sessionCount,
        ...(detected ? {} : { reason: `未找到 Zcode 数据库：${db}` }),
      };
    }
    case 'claude-code': {
      const root = claudeCodeHome();
      const projects = path.join(root, 'projects');
      const detected = fs.existsSync(projects);
      return {
        kind, label: 'Claude Code', home: root, detected,
        canRead: detected, canWrite: detected,
        sessionCount: detected ? countFiles(projects, (n) => n.endsWith('.jsonl')) : undefined,
        ...(detected ? {} : { reason: `未找到 Claude Code 会话目录：${projects}` }),
      };
    }
    case 'workbuddy': {
      const root = workbuddyHome();
      const db = path.join(root, 'workbuddy.db');
      const projects = path.join(root, 'projects');
      const detected = fs.existsSync(db);
      return {
        kind, label: 'WorkBuddy', home: root, detected,
        canRead: detected && fs.existsSync(projects),
        canWrite: detected,
        sessionCount: fs.existsSync(projects)
          ? countFiles(projects, (n) => n.endsWith('.jsonl'))
          : undefined,
        ...(detected ? {} : { reason: `未找到 WorkBuddy 数据库：${db}` }),
      };
    }
  }
}

/** 探测所有客户端 */
export function probeAllClients(): ClientStatus[] {
  const kinds: ClientKind[] = ['dsh', 'codex', 'zcode', 'claude-code', 'workbuddy'];
  return kinds.map(probeClient);
}

/**
 * 平台能力说明。
 *
 * 当前实现针对 Windows 做了路径编码（DSH projectKey、WorkBuddy/Claude Code 目录名）。
 * POSIX 系统理论上可用（路径编码函数对 `/` 也做了处理），但未经实测，
 * 因此显式声明并在 UI 提示。
 */
export function platformSupport(): { platform: string; fullySupported: boolean; note: string } {
  const p = process.platform;
  if (p === 'win32') {
    return { platform: p, fullySupported: true, note: 'Windows：已完整实测' };
  }
  if (p === 'darwin' || p === 'linux') {
    return {
      platform: p,
      fullySupported: false,
      note: `${p === 'darwin' ? 'macOS' : 'Linux'}：路径编码逻辑已兼容，但未在真机实测，请先小样本验证`,
    };
  }
  return { platform: p, fullySupported: false, note: `未支持的平台：${p}` };
}
