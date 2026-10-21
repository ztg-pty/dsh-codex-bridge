/**
 * budget/summarize.ts —— 上下文压缩引擎
 *
 * ★ 核心诉求（用户明确要求）：
 *   返还近乎完整的信息，但不超过 200k token；
 *   超限自动摘要，但**技术细节、具体参数不丢失**。
 *
 * 策略：不是均匀压缩，而是「按信息价值选择性丢弃」。
 *
 *   四级流水线：
 *     L0 原始      ≤ 预算 → 直接返回
 *     L1 去冗余    → 删重复、剥离注入模板（无损）
 *     L2 结构化    → 每条消息压成 {意图, 关键操作, 结果}，P0 片段逐字保留
 *     L3 骨架      → 早期轮次折叠成摘要句，只留决策链 + 文件清单
 *
 *   从最新往回保留：最近轮次最有用。
 *
 *   P0 保护：代码块、命令、路径、错误、参数、版本号 —— 逐字保留，绝不摘要。
 */
import type { UirSession, UirBlock, UirTurn, UirStep } from '../uir/types.js';
import { estimateTokens, effectiveBudget } from './tokens.js';
import { analyzeText, isInjectedTemplate } from '../uir/helpers.js';

// ───────────────────────── 保护片段提取 ─────────────────────────

const FENCE_RE = /```[\w+-]*\n[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]{1,200}`/g;
/**
 * 文件路径提取。
 *
 * 不用单一复杂正则（转义/URL/UNC 情况太多，正则容易切碎），
 * 改为「候选片段 + 归一化校验」：
 *   1. 先抓出连续的路径字符片段
 *   2. 归一化（把 \\ 折叠成 \）
 *   3. 校验：必须是绝对路径且至少两级，排除 URL
 */
const PATH_CANDIDATE_RE = /(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"'<>|*?`，。；：、）】]+/g;

function normalizePathCandidate(raw: string): string | null {
  // 排除 URL
  if (/^[a-zA-Z][\w+.-]*:\/\//.test(raw)) return null;
  // 去掉尾部标点
  let p = raw.replace(/[),.;:'"\]}>]+$/, '');
  if (!p) return null;
  // 折叠多重反斜杠（JSON 转义产生）
  const collapsed = p.replace(/\\\\/g, '\\');
  // 必须至少两级目录
  const segments = collapsed.split(/[\\/]+/).filter(Boolean);
  if (segments.length < 2) return null;
  // 长度合理
  if (collapsed.length < 6 || collapsed.length > 300) return null;
  return collapsed;
}

/** 提取路径（去重） */
export function extractPaths(text: string): string[] {
  const out = new Set<string>();
  if (!text) return [];
  for (const raw of text.match(PATH_CANDIDATE_RE) ?? []) {
    const p = normalizePathCandidate(raw);
    if (p) out.add(p);
  }
  return [...out];
}

/**
 * 文件路径正则（保留给 extractProtected 使用；单行内联匹配）。
 */
const PATH_RE = PATH_CANDIDATE_RE;
/**
 * 报错信息正则。
 * 不要求行首（实测报错常出现在行中间），并覆盖常见形态：
 *   Error: / Exception: / FATAL / panic / Traceback / XXX failed / error C1234
 */
const ERROR_RE = /(?:\b(?:Error|ERROR|Exception|FATAL|FAILED|panic|Traceback)\b[:：]?\s*[^\n]{0,200}|\berror\s+[A-Z]{1,4}\d{3,5}[^\n]{0,150}|\b[A-Za-z_][\w.]*\s+failed\b[^\n]{0,150})/g;
const VERSION_RE = /\bv?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?\b/g;
const CMD_RE = /(?:pwsh|powershell|bash|sh|cmd|node|npm|pnpm|git|python|npx)\s+(?:-[A-Za-z]+\s+)*[^\n]{3,300}/g;

export interface ProtectedPiece {
  kind: 'code' | 'inline-code' | 'path' | 'error' | 'version';
  text: string;
}

/** 提取必须逐字保留的技术片段 */
export function extractProtected(text: string): ProtectedPiece[] {
  const out: ProtectedPiece[] = [];
  const push = (kind: ProtectedPiece['kind'], arr: RegExpMatchArray | null) => {
    if (!arr) return;
    for (const m of arr) out.push({ kind, text: m });
  };
  push('code', text.match(FENCE_RE));
  push('inline-code', text.match(INLINE_CODE_RE));
  push('path', text.match(PATH_RE));
  push('error', text.match(ERROR_RE));
  push('version', text.match(VERSION_RE));
  // 去重（同一片段只保留一次）
  const seen = new Set<string>();
  return out.filter((p) => {
    const k = p.kind + '\u0000' + p.text;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ───────────────────────── 压缩结果 ─────────────────────────

export interface SummarizeOptions {
  /** token 预算（默认 200k，硬上限 200k） */
  budget?: number;
  /** 保真度：full 尽量不压 / balanced 默认 / compact 更激进 */
  fidelity?: 'full' | 'balanced' | 'compact';
  /** 关注点（提升匹配内容的保留优先级，如 ['报错','API 参数']） */
  focus?: string[];
}

export interface SummarizeStats {
  originalTokens: number;
  returnedTokens: number;
  compressionRatio: number;
  /** 实际使用的压缩级别 */
  level: 'L0' | 'L1' | 'L2' | 'L3';
  dropped: {
    narrative: number;   // 被压缩的叙述字符数
    duplicates: number;  // 去重省下的字符数
    injected: number;    // 剥离的注入模板字符数
    reasoning: number;   // 压缩的思考字符数
  };
  preserved: {
    codeBlocks: number;
    commands: number;
    paths: number;
    errors: number;
    toolCalls: number;
    /** 技术索引保留的条目数 */
    techIndexEntries?: number;
  };
  summarized: boolean;
}

export interface SummarizeResult {
  /** 压缩后的 markdown 上下文（可直接塞进对话） */
  context: string;
  /** 结构化大纲（机器可读） */
  outline: Array<{ turn: number; intent: string; files: string[]; tools: string[] }>;
  stats: SummarizeStats;
}

// ───────────────────────── 主流程 ─────────────────────────

/**
 * 把 UIR 会话压缩成不超过预算的上下文文本。
 */
export function summarizeSession(session: UirSession, opts: SummarizeOptions = {}): SummarizeResult {
  const budget = effectiveBudget(opts.budget);
  const fidelity = opts.fidelity ?? 'balanced';

  const stats: SummarizeStats = {
    originalTokens: 0,
    returnedTokens: 0,
    compressionRatio: 1,
    level: 'L0',
    dropped: { narrative: 0, duplicates: 0, injected: 0, reasoning: 0 },
    preserved: { codeBlocks: 0, commands: 0, paths: 0, errors: 0, toolCalls: 0 },
    summarized: false,
  };

  // 原始规模
  const originalText = renderFull(session);
  stats.originalTokens = estimateTokens(originalText);
  collectPreservedStats(session, stats);

  // 空会话：无内容可摘要，直接标记为 L3 骨架
  if (session.turns.length === 0) {
    stats.returnedTokens = stats.originalTokens;
    stats.level = 'L3';
    return {
      context: originalText + '\n\n（无对话内容）',
      outline: [],
      stats,
    };
  }

  // L0：不超预算，直接返回
  if (stats.originalTokens <= budget || fidelity === 'full' && stats.originalTokens <= budget * 1.05) {
    stats.returnedTokens = stats.originalTokens;
    stats.level = 'L0';
    return {
      context: originalText,
      outline: buildOutline(session),
      stats,
    };
  }

  // L1：去冗余（剥离注入模板 + 去重）
  const l1 = applyL1(session, stats);
  const l1Text = renderFull(l1);
  const l1Tokens = estimateTokens(l1Text);
  if (l1Tokens <= budget) {
    stats.returnedTokens = l1Tokens;
    stats.level = 'L1';
    stats.summarized = true;
    finishRatio(stats);
    return { context: l1Text, outline: buildOutline(l1), stats };
  }

  // L2 + L3：按轮次从新到旧分配预算
  const { context, level } = applyL2L3(l1, budget, fidelity, opts.focus ?? [], stats);
  stats.returnedTokens = estimateTokens(context);
  stats.level = level;
  stats.summarized = true;
  finishRatio(stats);
  return { context, outline: buildOutline(session), stats };
}

function finishRatio(stats: SummarizeStats): void {
  stats.compressionRatio = stats.originalTokens > 0
    ? Math.round((stats.returnedTokens / stats.originalTokens) * 1000) / 1000
    : 1;
}

// ───────────────────────── L1：去冗余 ─────────────────────────

/** 剥离注入模板 + 相邻重复去重 */
function applyL1(session: UirSession, stats: SummarizeStats): UirSession {
  const out: UirSession = { ...session, turns: [] };
  const seenTexts = new Set<string>();

  for (const turn of session.turns) {
    const newTurn: UirTurn = { ...turn, userMessages: [], steps: [] };

    for (const b of turn.userMessages) {
      if (b.kind === 'text') {
        if (isInjectedTemplate(b.text)) {
          stats.dropped.injected += b.text.length;
          continue;
        }
        const key = b.text.trim();
        if (key.length > 40 && seenTexts.has(key)) {
          stats.dropped.duplicates += b.text.length;
          continue;
        }
        if (key.length > 40) seenTexts.add(key);
      }
      newTurn.userMessages.push(b);
    }

    for (const step of turn.steps) {
      const newStep: UirStep = { ...step, blocks: [] };
      for (const b of step.blocks) {
        if (b.kind === 'text' && isInjectedTemplate(b.text)) {
          stats.dropped.injected += b.text.length;
          continue;
        }
        newStep.blocks.push(b);
      }
      newTurn.steps.push(newStep);
    }
    out.turns.push(newTurn);
  }
  return out;
}

// ───────────────────────── L2/L3：按轮次分配预算 ─────────────────────────

interface TurnCost {
  turn: UirTurn;
  tokens: number;
  /** L0 完整 / L2 结构化 / L3 骨架 */
  plan: 'L0' | 'L2' | 'L3';
}

function applyL2L3(
  session: UirSession,
  budget: number,
  fidelity: 'full' | 'balanced' | 'compact',
  focus: string[],
  stats: SummarizeStats,
): { context: string; level: 'L2' | 'L3' } {
  const turns = session.turns;
  const n = turns.length;
  if (n === 0) return { context: renderHeader(session, stats) + '\n\n（无对话内容）', level: 'L3' };

  const headerText = renderHeader(session, stats);
  // ★ 预留技术索引预算（全文去重的关键片段清单），
  //   否则轮次渲染会吃光预算，导致技术细节丢失。
  const techIndexReserve = Math.min(Math.floor(budget * 0.18), 30_000);
  let remaining = budget - estimateTokens(headerText) - techIndexReserve - 200;

  // 预计算每轮的两种渲染成本
  const costs = turns.map((t) => ({
    turn: t,
    fullTokens: estimateTokens(renderTurnFull(t)),
    l2Tokens: estimateTokens(renderTurnL2(t, focus, { ...stats, dropped: { ...stats.dropped }, preserved: { ...stats.preserved } })),
    plan: 'L3' as 'L0' | 'L2' | 'L3',
  }));

  // ── 第 1 步：最近轮次优先升到 L0（从最新往回）──
  const recentStart = Math.max(0, n - 3);
  for (let i = n - 1; i >= recentStart; i--) {
    if (costs[i].fullTokens <= remaining) {
      costs[i].plan = 'L0';
      remaining -= costs[i].fullTokens;
    }
  }

  // ── 第 2 步：中间轮次升到 L2（从新到旧）──
  for (let i = recentStart - 1; i >= 0; i--) {
    if (costs[i].plan !== 'L3') continue;
    if (costs[i].l2Tokens <= remaining) {
      costs[i].plan = 'L2';
      remaining -= costs[i].l2Tokens;
    }
  }

  // ── 第 3 步：预算回填 ──
  // 若仍有剩余，把 L2 的轮次升级为 L0（从新到旧），再把 L3 升级为 L2
  let upgraded = true;
  while (upgraded && remaining > 500) {
    upgraded = false;
    // 先尝试 L2 → L0
    for (let i = n - 1; i >= 0; i--) {
      if (costs[i].plan !== 'L2') continue;
      const delta = costs[i].fullTokens - costs[i].l2Tokens;
      if (delta <= remaining) {
        costs[i].plan = 'L0';
        remaining -= delta;
        upgraded = true;
        break;
      }
    }
    if (upgraded) continue;
    // 再尝试 L3 → L2
    for (let i = n - 1; i >= 0; i--) {
      if (costs[i].plan !== 'L3') continue;
      if (costs[i].l2Tokens <= remaining) {
        costs[i].plan = 'L2';
        remaining -= costs[i].l2Tokens;
        upgraded = true;
        break;
      }
    }
  }

  // 渲染
  const parts: string[] = [headerText];

  const earlyTurns = costs.filter((c) => c.plan === 'L3');
  if (earlyTurns.length > 0) {
    parts.push(renderEarlySummary(earlyTurns.map((c) => c.turn)));
  }

  for (const c of costs) {
    if (c.plan === 'L3') continue;
    if (c.plan === 'L0') parts.push(renderTurnFull(c.turn));
    else parts.push(renderTurnL2(c.turn, focus, stats));
  }

  // ★ 技术索引：把全文去重后的关键技术片段集中保留在末尾。
  //   这样即使早期轮次被折叠，其技术细节（文件/目录/命令/版本/报错）也不丢。
  const techIndex = buildTechIndex(session, Math.max(techIndexReserve, remaining));
  if (techIndex.text) {
    parts.push(techIndex.text);
    stats.preserved.techIndexEntries = techIndex.count;
  }

  const context = parts.join('\n\n');
  return { context, level: 'L2' };
}

/**
 * 构建「技术索引」——全文去重后的关键片段清单。
 *
 * 为什么需要：轮次级折叠（L3）会丢掉早期轮次的文本，
 * 但其中的路径/命令/报错/版本号是用户明确要求「不能丢」的技术细节。
 * 把它们去重后集中列出，用极小空间保住关键信息。
 */
function buildTechIndex(
  session: UirSession,
  remainingTokens: number,
): { text: string; count: number } {
  if (remainingTokens < 300) return { text: '', count: 0 };

  const paths = new Set<string>();
  const commands = new Set<string>();
  const errors = new Set<string>();
  const versions = new Set<string>();

  const collect = (text: string) => {
    if (!text) return;
    for (const p of text.match(PATH_RE) ?? []) {
      const t = p.trim();
      // 只保留有意义的路径（长度足够、含分隔符）
      if (t.length >= 8 && t.length <= 300) paths.add(t);
    }
    for (const c of text.match(CMD_RE) ?? []) {
      const t = c.trim();
      if (t.length >= 6 && t.length <= 300) commands.add(t);
    }
    for (const e of text.match(ERROR_RE) ?? []) {
      const t = e.trim();
      if (t.length >= 10 && t.length <= 400) errors.add(t);
    }
    for (const v of text.match(VERSION_RE) ?? []) {
      if (/^\d+\.\d+/.test(v)) versions.add(v);
    }
  };

  for (const turn of session.turns) {
    for (const b of turn.userMessages) {
      if (b.kind === 'text') collect(b.text);
    }
    for (const step of turn.steps) {
      if (step.reasoning) collect(step.reasoning);
      for (const b of step.blocks) {
        if (b.kind === 'text') collect(b.text);
        else if (b.kind === 'tool-call') collect(b.rawArgs ?? JSON.stringify(b.args ?? {}));
        else if (b.kind === 'tool-result') collect(b.output.text);
        else if (b.kind === 'file-change') { paths.add(b.path); if (b.diff) collect(b.diff); }
      }
    }
  }

  const sections: string[] = [];
  let count = 0;

  // ★ 容量由预算决定（而不是硬编码条数）：
  //   技术索引的价值就在于「尽可能全地保留关键实体」，
  //   只要预算够就应该多列，而不是固定只列 100 个。
  const budgetChars = Math.floor(remainingTokens * 3.5); // token → 字符 粗估
  let used = 0;

  const addSection = (title: string, items: string[], maxItems: number) => {
    if (items.length === 0) return;
    const picked: string[] = [];
    for (const it of items.slice(0, maxItems)) {
      // 预留 40 字符给 section 标题
      if (used + it.length + 4 > budgetChars - 40) break;
      picked.push(it);
      used += it.length + 4;
    }
    if (picked.length === 0) return;
    sections.push(`### ${title}（${picked.length}${picked.length < items.length ? ` / 共 ${items.length}` : ''}）\n` +
      picked.map((x) => `- \`${x}\``).join('\n'));
    count += picked.length;
  };

  // ★ 路径分两级呈现：
  //   「涉及文件」用基名（紧凑、去重率高、最能定位）
  //   「关键目录」用目录路径（保留结构信息）
  const fileNames = new Set<string>();
  const dirPaths = new Set<string>();
  for (const p of paths) {
    const segs = p.split(/[\\/]+/).filter(Boolean);
    if (segs.length === 0) continue;
    const base = segs[segs.length - 1];
    if (base && base.includes('.') && base.length <= 80) fileNames.add(base);
    // 目录：去掉文件名部分
    if (segs.length >= 3) {
      const dir = segs.slice(0, -1).join('\\');
      if (dir.length >= 8 && dir.length <= 200) dirPaths.add(dir);
    }
  }

  // ★ 优先级顺序（预算不足时靠前的优先保留）：
  //   报错 > 命令 > 文件 > 目录 > 版本
  //   理由：报错是用户最关心的（出了问题要定位），命令是「怎么做的」，
  //        文件是「改了哪里」，目录是结构，版本号价值最低。
  addSection('报错信息', [...errors], 300);
  addSection('执行过的命令', [...commands], 500);
  addSection('涉及的文件', [...fileNames].sort((a, b) => a.localeCompare(b)), 3000);
  addSection('关键目录', [...dirPaths].sort((a, b) => a.length - b.length), 2000);
  addSection('版本号', [...versions].sort(), 500);

  if (sections.length === 0) return { text: '', count: 0 };
  return {
    text: `\n## 技术索引（全文去重保留）\n\n${sections.join('\n\n')}`,
    count,
  };
}

// ───────────────────────── 渲染 ─────────────────────────

function renderHeader(session: UirSession, stats: SummarizeStats): string {
  const d = new Date(session.createdAt);
  const dateStr = Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 16).replace('T', ' ') : '未知时间';
  const lines = [
    `# 会话上下文：${session.title || '(无标题)'}`,
    `> 来源 ${session.origin.client} · ${dateStr} · 工作目录 ${session.cwd || '(未知)'}`,
    `> 原始约 ${stats.originalTokens} tokens（压缩后见文末统计）`,
  ];
  return lines.join('\n');
}

/** L0：完整渲染 */
function renderFull(session: UirSession): string {
  const parts: string[] = [`# 会话上下文：${session.title || '(无标题)'}`];
  parts.push(`> 来源 ${session.origin.client} · 工作目录 ${session.cwd || '(未知)'}`);
  for (const turn of session.turns) parts.push(renderTurnFull(turn));
  return parts.join('\n\n');
}

function renderTurnFull(turn: UirTurn): string {
  const lines: string[] = [`## 第 ${turn.index + 1} 轮`];
  for (const b of turn.userMessages) {
    if (b.kind === 'text') lines.push(`**用户**：${demoteHeadings(b.text)}`);
  }
  for (const step of turn.steps) {
    for (const b of step.blocks) lines.push(renderBlockFull(b));
  }
  return lines.filter(Boolean).join('\n');
}

function renderBlockFull(b: UirBlock): string {
  switch (b.kind) {
    case 'text':
      return b.role === 'assistant'
        ? `**助手**：${demoteHeadings(b.text)}`
        : `**${b.role}**：${demoteHeadings(b.text)}`;
    case 'reasoning':
      return b.encrypted
        ? `> [加密思考 · 无法解码 · ${b.encryptedBytes ?? 0} 字节]`
        : `> 💭 ${b.text}`;
    case 'tool-call':
      // L0 完整渲染：参数不截断（技术细节核心）
      return `- 🔧 \`${b.name}\`(${b.rawArgs ?? JSON.stringify(b.args ?? {})})`;
    case 'tool-result':
      // L0 完整渲染：输出不截断
      return `- ${b.isError ? '⚠️' : '✅'} 结果：${b.output.text}`;
    case 'file-change':
      return `- 📝 ${b.operation} \`${b.path}\`${b.diff ? '\n```diff\n' + b.diff + '\n```' : ''}`;
    case 'image':
      return `- 🖼 图片 (${b.mime})`;
    case 'compaction':
      return `- 🗜 上下文压缩：${b.summary}`;
    default:
      return '';
  }
}

/**
 * L2：结构化渲染 —— 保留 P0 片段，压缩叙述。
 */
function renderTurnL2(turn: UirTurn, focus: string[], stats: SummarizeStats): string {
  const lines: string[] = [`## 第 ${turn.index + 1} 轮（摘要）`];

  // 用户输入：保留原文（用户意图最重要）
  for (const b of turn.userMessages) {
    if (b.kind === 'text') {
      lines.push(`**用户**：${demoteHeadings(truncate(b.text, 1500))}`);
    }
  }

  for (const step of turn.steps) {
    // 思考：只保留结论性语句
    if (step.reasoning) {
      const conclusion = extractConclusion(step.reasoning);
      if (conclusion) {
        stats.dropped.reasoning += Math.max(0, step.reasoning.length - conclusion.length);
        lines.push(`> 💭 ${conclusion}`);
      }
    }

    for (const b of step.blocks) {
      switch (b.kind) {
        case 'text': {
          if (b.role !== 'assistant') break;
          const compressed = compressText(b.text, focus, stats);
          if (compressed) lines.push(`**助手**：${demoteHeadings(compressed)}`);
          break;
        }
        case 'reasoning': {
          if (b.encrypted) break;
          const conclusion = extractConclusion(b.text);
          if (conclusion) {
            stats.dropped.reasoning += Math.max(0, b.text.length - conclusion.length);
            lines.push(`> 💭 ${conclusion}`);
          }
          break;
        }
        case 'tool-call':
          lines.push(`- 🔧 \`${b.name}\` ${truncate(b.rawArgs ?? JSON.stringify(b.args ?? {}), 800)}`);
          break;
        case 'tool-result': {
          // ★ 工具输出是技术细节最密集处（路径/命令/报错/参数），
          //   截断阈值放大并强制保留所有技术片段。
          const out = b.output.text;
          const preserved = truncatePreservingTech(out, 4000, stats);
          lines.push(`  ${b.isError ? '⚠️ 错误' : '✅'}：${preserved}`);
          break;
        }
        case 'file-change':
          lines.push(`- 📝 ${b.operation} \`${b.path}\``);
          break;
        case 'image':
          lines.push(`- 🖼 图片 (${b.mime})`);
          break;
        default:
          break;
      }
    }
  }
  return lines.join('\n');
}

/** L3：早期轮次折叠 */
function renderEarlySummary(turns: UirTurn[]): string {
  if (turns.length === 0) return '';
  const first = turns[0].index + 1;
  const last = turns[turns.length - 1].index + 1;

  // 提取每轮的关键动作
  const intents: string[] = [];
  const files = new Set<string>();
  const tools = new Set<string>();

  for (const t of turns) {
    for (const b of t.userMessages) {
      if (b.kind === 'text') {
        const s = b.text.replace(/\s+/g, ' ').trim().slice(0, 60);
        if (s) intents.push(s);
      }
    }
    for (const step of t.steps) {
      for (const b of step.blocks) {
        if (b.kind === 'tool-call') tools.add(b.name);
        if (b.kind === 'file-change') files.add(b.path);
      }
    }
  }

  const lines = [
    `## 概览（第 ${first}–${last} 轮，已折叠）`,
    intents.length > 0
      ? `- 用户诉求：${[...new Set(intents)].slice(0, 8).map((s) => `「${s}」`).join('、')}`
      : '- （无明确诉求记录）',
  ];
  if (files.size > 0) {
    lines.push(`- 涉及文件：${[...files].slice(0, 15).map((f) => `\`${f}\``).join('、')}${files.size > 15 ? ` 等 ${files.size} 个` : ''}`);
  }
  if (tools.size > 0) {
    lines.push(`- 使用工具：${[...tools].join('、')}`);
  }
  return lines.join('\n');
}

// ───────────────────────── 文本压缩 ─────────────────────────

/** 压缩叙述性文本：保留 P0 片段 + 首尾句 */
function compressText(text: string, focus: string[], stats: SummarizeStats): string {
  const f = analyzeText(text);
  // 短文本直接保留
  if (text.length <= 400) return text;

  // 含大量技术特征 → 保留更多
  const techScore = f.codeBlocks * 10 + f.paths * 3 + f.errors * 8 + f.commands * 5;
  const keepChars = techScore > 10 ? 2000 : techScore > 3 ? 1200 : 600;

  if (text.length <= keepChars) return text;

  const protectedPieces = extractProtected(text);
  // 首段 + 尾段
  const head = text.slice(0, Math.floor(keepChars * 0.6));
  const tail = text.slice(-Math.floor(keepChars * 0.25));

  // 关注点命中
  const focusHits: string[] = [];
  for (const kw of focus) {
    const idx = text.indexOf(kw);
    if (idx >= 0) focusHits.push(text.slice(Math.max(0, idx - 100), Math.min(text.length, idx + 300)));
  }

  const droppedChars = text.length - (head.length + tail.length);
  stats.dropped.narrative += Math.max(0, droppedChars);

  const pieces: string[] = [head.trim()];
  if (focusHits.length > 0) {
    pieces.push(`[关注点片段]\n${focusHits.join('\n…\n')}`);
  }
  // 确保关键 P0 片段不丢（若不在首尾里则补上）
  const missing = protectedPieces.filter((p) => !head.includes(p.text) && !tail.includes(p.text));
  if (missing.length > 0) {
    pieces.push(`[关键细节]\n${missing.slice(0, 20).map((p) => p.text).join('\n')}`);
  }
  pieces.push('…（此处省略部分叙述）…');
  pieces.push(tail.trim());
  return pieces.join('\n');
}

/** 截断但保留技术细节 */
function truncatePreservingTech(text: string, max: number, stats: SummarizeStats): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(-Math.floor(max * 0.25));
  const pieces = extractProtected(text);
  const missing = pieces.filter((p) => !head.includes(p.text) && !tail.includes(p.text));
  stats.dropped.narrative += Math.max(0, text.length - head.length - tail.length);
  let out = `${head.trim()}\n…（省略 ${text.length - head.length - tail.length} 字符）…\n${tail.trim()}`;
  if (missing.length > 0) {
    out += `\n[关键细节]\n${missing.slice(0, 15).map((p) => p.text).join('\n')}`;
  }
  return out;
}

/** 提取思考的结论句（最后一段判断性语句） */
function extractConclusion(reasoning: string): string {
  if (!reasoning) return '';
  if (reasoning.length <= 300) return reasoning.trim();

  // 按段落/句子切分，取最后 2-3 句（通常是结论）
  const paragraphs = reasoning.split(/\n{2,}/).filter((p) => p.trim());
  const lastParas = paragraphs.slice(-2).join('\n');
  const sentences = lastParas.split(/(?<=[。.!?！？])\s+/).filter((s) => s.trim());
  const conclusion = sentences.slice(-3).join(' ').trim();

  return conclusion.length > 20 ? conclusion.slice(0, 800) : lastParas.slice(0, 500).trim();
}

function truncate(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max) + `…（省略 ${s.length - max} 字符）`;
}

/**
 * 降级原文里的 Markdown 标题，避免和本引擎的 `## 第 N 轮` 结构混淆。
 * 做法：把行首的 `#` 替换为 `▪`（保留视觉层级感，但不被解析为标题）。
 */
function demoteHeadings(text: string): string {
  if (!text) return text;
  return text.replace(/^(\s{0,3})(#{1,6})(\s+)/gm, (_m, indent: string, hashes: string, space: string) =>
    `${indent}${'▪'.repeat(hashes.length)}${space}`);
}

// ───────────────────────── 统计与大纲 ─────────────────────────

function collectPreservedStats(session: UirSession, stats: SummarizeStats): void {
  for (const turn of session.turns) {
    for (const b of turn.userMessages) {
      if (b.kind === 'text') {
        const f = analyzeText(b.text);
        stats.preserved.paths += f.paths;
        stats.preserved.errors += f.errors;
        stats.preserved.codeBlocks += f.codeBlocks;
        stats.preserved.commands += f.commands;
      }
    }
    for (const step of turn.steps) {
      for (const b of step.blocks) {
        if (b.kind === 'tool-call') stats.preserved.toolCalls++;
        if (b.kind === 'text') {
          const f = analyzeText(b.text);
          stats.preserved.paths += f.paths;
          stats.preserved.errors += f.errors;
          stats.preserved.codeBlocks += f.codeBlocks;
          stats.preserved.commands += f.commands;
        }
        if (b.kind === 'tool-result') {
          const f = analyzeText(b.output.text);
          stats.preserved.paths += f.paths;
          stats.preserved.errors += f.errors;
        }
      }
    }
  }
}

function buildOutline(session: UirSession): Array<{ turn: number; intent: string; files: string[]; tools: string[] }> {
  return session.turns.map((t) => {
    let intent = '';
    const files = new Set<string>();
    const tools = new Set<string>();

    for (const b of t.userMessages) {
      if (b.kind === 'text' && !intent) {
        intent = b.text.replace(/\s+/g, ' ').trim().slice(0, 100);
      }
    }
    for (const step of t.steps) {
      for (const b of step.blocks) {
        if (b.kind === 'tool-call') tools.add(b.name);
        if (b.kind === 'file-change') files.add(b.path);
      }
    }
    return { turn: t.index + 1, intent, files: [...files], tools: [...tools] };
  });
}

/** 生成统计摘要（人类可读） */
export function formatStats(stats: SummarizeStats): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return [
    `原始 ${stats.originalTokens} tokens → 返回 ${stats.returnedTokens} tokens（保留 ${pct(stats.compressionRatio)}）`,
    `压缩级别 ${stats.level}${stats.summarized ? '（已摘要）' : '（未摘要）'}`,
    `保留：代码块 ${stats.preserved.codeBlocks} · 命令 ${stats.preserved.commands} · 路径 ${stats.preserved.paths} · 报错 ${stats.preserved.errors} · 工具调用 ${stats.preserved.toolCalls}`,
    `丢弃：注入模板 ${stats.dropped.injected} 字符 · 重复 ${stats.dropped.duplicates} 字符 · 叙述 ${stats.dropped.narrative} 字符 · 思考 ${stats.dropped.reasoning} 字符`,
  ].join('\n');
}
