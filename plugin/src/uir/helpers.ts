/**
 * uir/helpers.ts —— UIR 工具函数
 *
 * 提供：
 *   - 内容价值等级判定（供 Token 预算器）
 *   - 文本特征检测（代码块、路径、命令、错误）
 *   - 会话结构校验
 *   - 统计信息
 */
import type { UirBlock, UirSession, UirTurn, UirStep, ValueTier } from './types.js';

// ───────────────────────── 特征检测 ─────────────────────────

/** 代码围栏 ```lang\n...\n``` */
const FENCE_RE = /```[\s\S]*?```/g;
/** 行内代码 `...` */
const INLINE_CODE_RE = /`[^`\n]+`/g;
/** 文件路径（Windows / Unix / UNC） */
const PATH_RE = /(?:[A-Za-z]:[\\/][^\s"'<>|*?\n]+|\/(?:[\w.-]+\/){2,}[\w.-]+|\\\\[\w.$-]+\\[^\s"'<>|*?\n]+)/g;
/** 命令行 */
const CMD_RE = /(?:^|\n)\s*(?:\$|>|PS>)\s+[^\n]+|(?:pwsh|powershell|bash|sh|cmd|node|npm|pnpm|git|python)\s+(?:-[A-Za-z]+\s+)*[^\n]{3,}/g;
/** 错误信息 */
const ERROR_RE = /\b(?:Error|Exception|FATAL|FAILED|panic|Traceback)\b[^\n]{0,300}/g;
/** 版本号 */
const VERSION_RE = /\bv?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?\b/g;
/** JSON 片段（粗略） */
const JSON_RE = /[{[][\s\S]{20,}?[}\]]/g;

export interface TextFeatures {
  codeBlocks: number;
  inlineCode: number;
  paths: number;
  commands: number;
  errors: number;
  versions: number;
  hasJson: boolean;
  length: number;
}

/** 提取文本特征（用于价值判定与统计） */
export function analyzeText(text: string): TextFeatures {
  if (!text) {
    return { codeBlocks: 0, inlineCode: 0, paths: 0, commands: 0, errors: 0, versions: 0, hasJson: false, length: 0 };
  }
  return {
    codeBlocks: (text.match(FENCE_RE) ?? []).length,
    inlineCode: (text.match(INLINE_CODE_RE) ?? []).length,
    paths: (text.match(PATH_RE) ?? []).length,
    commands: (text.match(CMD_RE) ?? []).length,
    errors: (text.match(ERROR_RE) ?? []).length,
    versions: (text.match(VERSION_RE) ?? []).length,
    hasJson: JSON_RE.test(text),
    length: text.length,
  };
}

/**
 * 判定一段文本的价值等级。
 *
 * 核心思想：含技术细节（代码/路径/命令/错误）的内容是高价值，永不删；
 * 纯叙述性内容可压缩；环境注入模板可丢弃。
 */
export function classifyText(text: string, opts: { injected?: boolean; role?: string } = {}): ValueTier {
  if (!text || !text.trim()) return 'low';

  // 环境注入模板（AGENTS.md、environment_context 等）→ 可丢
  if (opts.injected) return 'low';

  const f = analyzeText(text);

  // 含代码块 / 错误 / 命令 / 多个路径 → critical
  if (f.codeBlocks > 0 || f.errors > 0 || f.commands > 0) return 'critical';
  if (f.paths >= 2 || (f.paths >= 1 && f.inlineCode >= 1)) return 'critical';

  // 含路径、JSON、版本号 → high
  if (f.paths >= 1 || f.hasJson || f.versions >= 2) return 'high';

  // 很短的客套话 → low
  const trimmed = text.trim();
  if (trimmed.length < 20) return 'low';

  // 纯叙述（无技术特征）→ medium
  return 'medium';
}

/** 是否为注入的上下文模板 */
export function isInjectedTemplate(text: string): boolean {
  return /^#\s*AGENTS\.md instructions/.test(text)
    || /^<environment_context>/.test(text)
    || /^<system-reminder>/.test(text)
    || /^<local-command-caveat>/.test(text)
    || /^Current runtime context\./.test(text)
    || /^Time sampled while preparing/.test(text);
}

// ───────────────────────── 统计 ─────────────────────────

export interface SessionStats {
  turns: number;
  steps: number;
  blocks: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  reasoningBlocks: number;
  encryptedBlocks: number;
  images: number;
  fileChanges: number;
  /** 各 tier 的块数 */
  tiers: Record<ValueTier, number>;
  /** 文本总字符数（token 估算基础） */
  chars: number;
}

/** 统计 UIR 会话 */
export function sessionStats(session: UirSession): SessionStats {
  const stats: SessionStats = {
    turns: session.turns.length,
    steps: 0, blocks: 0, userMessages: 0, assistantMessages: 0,
    toolCalls: 0, toolResults: 0, reasoningBlocks: 0,
    encryptedBlocks: 0, images: 0, fileChanges: 0,
    tiers: { critical: 0, high: 0, medium: 0, low: 0 },
    chars: 0,
  };

  for (const turn of session.turns) {
    for (const b of turn.userMessages) {
      stats.blocks++;
      stats.userMessages++;
      stats.tiers[b.tier]++;
      stats.chars += blockChars(b);
    }
    for (const step of turn.steps) {
      stats.steps++;
      for (const b of step.blocks) {
        stats.blocks++;
        stats.tiers[b.tier]++;
        stats.chars += blockChars(b);
        switch (b.kind) {
          case 'text': if (b.role === 'assistant') stats.assistantMessages++; break;
          case 'tool-call': stats.toolCalls++; break;
          case 'tool-result': stats.toolResults++; break;
          case 'reasoning': stats.reasoningBlocks++; if (b.encrypted) stats.encryptedBlocks++; break;
          case 'image': stats.images++; break;
          case 'file-change': stats.fileChanges++; break;
          default: break;
        }
      }
    }
  }
  return stats;
}

/** 单个块的字符数（用于 token 估算） */
export function blockChars(b: UirBlock): number {
  switch (b.kind) {
    case 'text': return b.text.length;
    case 'reasoning': return b.text.length;
    case 'tool-call': return (b.rawArgs ?? JSON.stringify(b.args ?? {})).length;
    case 'tool-result': return b.output.text.length;
    case 'file-change': return (b.diff ?? '').length;
    case 'compaction': return b.summary.length;
    case 'image': return 0;
    default: return 0;
  }
}

// ───────────────────────── 校验 ─────────────────────────

export interface ValidationIssue {
  level: 'error' | 'warning';
  message: string;
  path: string;
}

/** 校验 UIR 会话结构（写入目标端前自检） */
export function validateSession(session: UirSession): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!session.id) issues.push({ level: 'error', message: '会话缺少 id', path: 'id' });
  if (typeof session.createdAt !== 'number' || !Number.isFinite(session.createdAt)) {
    issues.push({ level: 'error', message: 'createdAt 非法', path: 'createdAt' });
  }
  if (!Array.isArray(session.turns)) {
    issues.push({ level: 'error', message: 'turns 不是数组', path: 'turns' });
    return issues;
  }

  // 轮次索引应连续
  session.turns.forEach((t, i) => {
    if (t.index !== i) {
      issues.push({ level: 'warning', message: `turn.index 不连续（期望 ${i}，实际 ${t.index}）`, path: `turns[${i}].index` });
    }
  });

  // 工具调用与结果配对检查
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const t of session.turns) {
    for (const s of t.steps) {
      for (const b of s.blocks) {
        if (b.kind === 'tool-call') calls.add(b.callId);
        if (b.kind === 'tool-result') results.add(b.callId);
      }
    }
  }
  for (const id of calls) {
    if (!results.has(id)) {
      issues.push({ level: 'warning', message: `工具调用 ${id} 没有对应结果`, path: 'tool-call' });
    }
  }
  for (const id of results) {
    if (!calls.has(id)) {
      issues.push({ level: 'warning', message: `工具结果 ${id} 没有对应调用`, path: 'tool-result' });
    }
  }

  return issues;
}

/** 创建空会话骨架（适配器读取失败时的兜底） */
export function emptySession(origin: { client: UirSession['origin']['client']; originalId: string }, cwd = ''): UirSession {
  const now = Date.now();
  return {
    id: `uir-${now}`,
    title: '(无标题)',
    cwd,
    createdAt: now,
    updatedAt: now,
    origin,
    turns: [],
    warnings: [],
  };
}

/** 深拷贝（避免适配器之间互相污染） */
export function cloneSession(s: UirSession): UirSession {
  return structuredClone(s);
}

/** 遍历所有块（只读） */
export function forEachBlock(session: UirSession, fn: (b: UirBlock, turn: UirTurn, step?: UirStep) => void): void {
  for (const turn of session.turns) {
    for (const b of turn.userMessages) fn(b, turn);
    for (const step of turn.steps) {
      for (const b of step.blocks) fn(b, turn, step);
    }
  }
}
