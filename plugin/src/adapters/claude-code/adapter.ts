/**
 * adapters/claude-code/adapter.ts —— Claude Code 会话适配器
 *
 * 存储格式（实测 ~/.claude/projects/<cwd编码>/<sessionId>.jsonl）：
 *   cwd 编码：D:\UE Save\fpsys\FPS_Extraction → D--UE-Save-fpsys-FPS-Extraction
 *   行类型：user | assistant | attachment | system | mode | permission-mode |
 *          file-history-snapshot | last-prompt | cost-state | atis-latch
 *
 * 关键字段：
 *   user:      { parentUuid, type:'user', message:{role,content}, uuid, timestamp, cwd, sessionId, isMeta }
 *   assistant: { parentUuid, message:{ model, id, role, content:[text|tool_use], usage }, uuid, timestamp }
 *   attachment:{ attachment:{type:'environment',snapshot:{...}}, rendered:[...] }
 *
 * 特点：parentUuid 形成消息树（支持分支）；attachment 承载环境快照。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  SessionAdapter, AdapterCapability, ReadOptions, ReadResult,
  WriteOptions, WriteResult, SessionSummary, UirSession, UirTurn, UirStep, UirBlock,
} from '../../uir/types.js';
import { classifyText, isInjectedTemplate } from '../../uir/helpers.js';
import { claudeCodeHome } from '../../host/clients.js';

/**
 * Claude Code 的 cwd → 目录名编码（实测）。
 *
 *   D:\UE Save\fpsys\FPS_Extraction → D--UE-Save-fpsys-FPS-Extraction
 *
 * 规则（从实测样本反推）：
 *   - 盘符后的 `:` → `--`
 *   - `\` 或 `/` → `-`
 *   - 空格、下划线 → `-`
 */
export function encodeCwdDir(cwd: string): string {
  // 1) 先剥离盘符（唯一会产生双横线的地方）
  const driveMatch = cwd.match(/^([A-Za-z]):/);
  const drive = driveMatch ? driveMatch[1] : '';
  let rest = driveMatch ? cwd.slice(2) : cwd;

  // 2) 分隔符 / 空格 / 下划线统一转单横线，并折叠重复
  rest = rest
    .replace(/[\\/]+/g, '-')
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-/, '');   // 去掉开头横线（盘符后的分隔符已剥离）

  // 3) 拼回盘符（用双横线分隔）
  return drive ? `${drive}--${rest}` : `-${rest}`;
}

/** 反向解码（尽力而为，不保证精确——编码有损） */
export function decodeCwdDir(dir: string): string {
  return dir.replace(/^([A-Za-z])--/, '$1:\\').replace(/-/g, '\\');
}

interface CcLine {
  type: string;
  parentUuid?: string | null;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    model?: string;
    usage?: Record<string, number>;
  };
  attachment?: { type?: string; snapshot?: Record<string, unknown> };
  [k: string]: unknown;
}

/** 判断文本是否为 CLI 内部标记（非真实用户输入） */
function isCliMarker(text: string): boolean {
  return /^\s*<(?:command-name|command-message|command-args|local-command-stdout|local-command-caveat|system-reminder)[\s>]/.test(text)
    || /<\/command-name>/.test(text);
}

/** 清理标题文本（去掉 CLI 标记） */
function cleanTitle(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}
function readLines(file: string): CcLine[] {
  const text = fs.readFileSync(file, 'utf8');
  const out: CcLine[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 损坏行跳过
    }
  }
  return out;
}

/** 把 Claude Code 的 content 转成 UIR blocks */
function contentToBlocks(content: any, role: 'user' | 'assistant' | 'system' | 'developer'): UirBlock[] {
  const blocks: UirBlock[] = [];
  if (content === undefined || content === null) return blocks;

  if (typeof content === 'string') {
    blocks.push({
      kind: 'text', role,
      text: content,
      tier: classifyText(content, { injected: isInjectedTemplate(content) }),
      injected: isInjectedTemplate(content),
    });
    return blocks;
  }

  if (!Array.isArray(content)) return blocks;

  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string') {
          blocks.push({
            kind: 'text', role, text: b.text,
            tier: classifyText(b.text, { injected: isInjectedTemplate(b.text) }),
            injected: isInjectedTemplate(b.text),
          });
        }
        break;
      case 'thinking':
        if (typeof b.thinking === 'string') {
          blocks.push({ kind: 'reasoning', text: b.thinking, tier: 'medium' });
        }
        break;
      case 'tool_use':
        blocks.push({
          kind: 'tool-call',
          callId: String(b.id ?? `call-${crypto.randomUUID()}`),
          name: String(b.name ?? 'tool'),
          args: b.input ?? {},
          rawArgs: JSON.stringify(b.input ?? {}),
          tier: 'critical',
        });
        break;
      case 'tool_result': {
        const out = typeof b.content === 'string'
          ? b.content
          : Array.isArray(b.content)
            ? b.content.map((x: any) => (typeof x?.text === 'string' ? x.text : '')).join('\n')
            : JSON.stringify(b.content ?? '');
        blocks.push({
          kind: 'tool-result',
          callId: String(b.tool_use_id ?? ''),
          output: { text: out, originalLength: out.length },
          isError: b.is_error === true,
          tier: 'critical',
        });
        break;
      }
      case 'image':
        blocks.push({
          kind: 'image',
          mime: String(b.source?.media_type ?? 'image/png'),
          ref: String(b.source?.data ?? b.source?.url ?? ''),
          refKind: b.source?.type === 'base64' ? 'data-url' : 'file',
          tier: 'high',
        });
        break;
      default:
        break;
    }
  }
  return blocks;
}

export class ClaudeCodeAdapter implements SessionAdapter {
  readonly capability: AdapterCapability = {
    client: 'claude-code',
    label: 'Claude Code',
    canRead: true,
    canWrite: true,
    supportsSubagent: true,      // isSidechain
    supportsImage: true,
    supportsFileChange: true,    // file-history-snapshot
    supportsBranching: true,     // parentUuid 树
    lossyFields: ['消息分支结构（跨端线性化）', 'file-history-snapshot 内部状态'],
  };

  probe(): { available: boolean; reason?: string } {
    const dir = path.join(claudeCodeHome(), 'projects');
    if (!fs.existsSync(dir)) {
      return { available: false, reason: `未找到 Claude Code 会话目录：${dir}` };
    }
    return { available: true };
  }

  /** 列出所有会话 */
  async list(): Promise<SessionSummary[]> {
    const root = path.join(claudeCodeHome(), 'projects');
    const out: SessionSummary[] = [];
    let projects: string[] = [];
    try {
      projects = await fsp.readdir(root);
    } catch {
      return out;
    }

    for (const proj of projects) {
      const projDir = path.join(root, proj);
      let files: string[] = [];
      try {
        files = (await fsp.readdir(projDir)).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        const file = path.join(projDir, f);
        try {
          const st = await fsp.stat(file);
          const lines = readLines(file);
          const first = lines.find((l) => l.type === 'user' || l.type === 'assistant');
          const cwd = lines.find((l) => typeof l.cwd === 'string')?.cwd ?? decodeCwdDir(proj);
          const sessionId = f.replace(/\.jsonl$/, '');
          // 标题：首条非 meta 用户消息
          let title = '(无标题)';
          for (const l of lines) {
            if (l.type === 'user' && !l.isMeta) {
              const c = l.message?.content;
              const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => b?.text ?? '').join(' ') : '';
              if (text && !isInjectedTemplate(text) && !isCliMarker(text)) { const t = cleanTitle(text); if (t) { title = t; break; } }
            }
          }
          out.push({
            client: 'claude-code',
            id: sessionId,
            title,
            cwd,
            createdAt: first?.timestamp ? Date.parse(first.timestamp) : st.birthtimeMs,
            updatedAt: st.mtimeMs,
            turns: lines.filter((l) => l.type === 'user' && !l.isMeta).length,
          });
        } catch {
          // 跳过损坏文件
        }
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 找到会话文件 */
  private findFile(sessionId: string): string | null {
    const root = path.join(claudeCodeHome(), 'projects');
    let projects: string[] = [];
    try {
      projects = fs.readdirSync(root);
    } catch {
      return null;
    }
    for (const proj of projects) {
      const file = path.join(root, proj, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
    return null;
  }

  /** 读取为 UIR */
  async read(opts: ReadOptions): Promise<ReadResult> {
    const file = this.findFile(opts.sessionId);
    if (!file) {
      throw new Error(`未找到 Claude Code 会话：${opts.sessionId}`);
    }
    const lines = readLines(file);
    const warnings: string[] = [];

    // 元信息
    const cwd = lines.find((l) => typeof l.cwd === 'string')?.cwd ?? '';
    const firstTs = lines.find((l) => typeof l.timestamp === 'string')?.timestamp;
    const createdAt = firstTs ? Date.parse(firstTs) : Date.now();
    const model = lines.find((l) => l.message?.model)?.message?.model;

    // 环境快照
    const envAttachment = lines.find((l) => l.attachment?.type === 'environment');
    const envSnapshot = envAttachment?.attachment?.snapshot;

    // 按 user 消息切分轮次
    const turns: UirTurn[] = [];
    let current: UirTurn | null = null;
    let step: UirStep | null = null;
    let title = '';

    for (const l of lines) {
      if (l.type === 'user' && !l.isMeta) {
        // 新轮次
        if (current) turns.push(current);
        current = {
          index: turns.length,
          startedAt: l.timestamp ? Date.parse(l.timestamp) : Date.now(),
          userMessages: [],
          steps: [],
          rawId: l.uuid,
        };
        step = { index: 0, blocks: [], rawId: l.uuid };
        current.steps.push(step);

        const blocks = contentToBlocks(l.message?.content, 'user');
        // 过滤纯注入模板
        const real = blocks.filter((b) => !(b.kind === 'text' && b.injected));
        for (const b of real) current.userMessages.push(b);
        if (!title) {
          const t = real.find((b) => b.kind === 'text' && !isCliMarker(String((b as any).text))) as any;
          if (t) title = cleanTitle(String(t.text));
        }
        continue;
      }

      if (l.type === 'assistant' && current && step) {
        const blocks = contentToBlocks(l.message?.content, 'assistant');
        // 思考单独提出
        const reasoning = blocks.filter((b) => b.kind === 'reasoning')
          .map((b: any) => b.text).join('\n');
        if (reasoning && !step.reasoning) step.reasoning = reasoning;
        for (const b of blocks) {
          if (b.kind !== 'reasoning') step.blocks.push(b);
        }
        // 用量
        const u = l.message?.usage;
        if (u) {
          step.usage = {
            input: u.input_tokens,
            output: u.output_tokens,
            cacheRead: u.cache_read_input_tokens,
            cacheWrite: u.cache_creation_input_tokens,
          };
        }
        continue;
      }

      if (l.type === 'system' && current) {
        const blocks = contentToBlocks(l.message?.content ?? l['content'], 'system');
        for (const b of blocks) {
          if (b.kind === 'text' && !b.injected) current.userMessages.push(b);
        }
      }
    }
    if (current) turns.push(current);

    const session: UirSession = {
      id: `cc-${opts.sessionId}`,
      title: title || '(无标题)',
      cwd,
      createdAt,
      updatedAt: fs.statSync(file).mtimeMs,
      origin: {
        client: 'claude-code',
        originalId: opts.sessionId,
        raw: { file, envSnapshot },
      },
      model: model ? { id: model } : undefined,
      turns,
      warnings,
    };

    return { session, warnings };
  }

  /** 写入（UIR → Claude Code JSONL） */
  async write(session: UirSession, opts: WriteOptions = {}): Promise<WriteResult> {
    const cwd = opts.cwd ?? session.cwd ?? process.cwd();
    const sessionId = crypto.randomUUID();
    const projDir = path.join(claudeCodeHome(), 'projects', encodeCwdDir(cwd));
    const file = path.join(projDir, `${sessionId}.jsonl`);

    const lines: Array<Record<string, unknown>> = [];
    let parentUuid: string | null = null;
    const baseMeta = {
      cwd,
      sessionId,
      version: '2.1.295',
      userType: 'external',
      entrypoint: 'cli',
    };

    // 环境附件
    const envUuid = crypto.randomUUID();
    lines.push({
      parentUuid: null,
      isSidechain: false,
      type: 'attachment',
      attachment: {
        type: 'environment',
        snapshot: {
          workingDirectory: cwd,
          isWorktree: false,
          isGitRepo: false,
          additionalWorkingDirectories: [],
          platform: process.platform === 'win32' ? 'win32' : process.platform,
          shell: 'bash',
        },
      },
      uuid: envUuid,
      timestamp: new Date(session.createdAt).toISOString(),
      ...baseMeta,
    });
    parentUuid = envUuid;

    for (const turn of session.turns) {
      // 用户消息
      for (const b of turn.userMessages) {
        if (b.kind !== 'text') continue;
        const uuid = crypto.randomUUID();
        lines.push({
          parentUuid,
          isSidechain: false,
          type: 'user',
          message: { role: 'user', content: b.text },
          uuid,
          timestamp: new Date(turn.startedAt).toISOString(),
          ...baseMeta,
        });
        parentUuid = uuid;
      }

      // 助手消息
      for (const step of turn.steps) {
        const content: Array<Record<string, unknown>> = [];
        if (step.reasoning) {
          content.push({ type: 'thinking', thinking: step.reasoning });
        }
        for (const b of step.blocks) {
          if (b.kind === 'text' && b.role === 'assistant') {
            content.push({ type: 'text', text: b.text });
          } else if (b.kind === 'tool-call') {
            content.push({ type: 'tool_use', id: b.callId, name: b.name, input: b.args });
          } else if (b.kind === 'tool-result') {
            content.push({
              type: 'tool_result',
              tool_use_id: b.callId,
              content: b.output.text,
              is_error: b.isError,
            });
          }
        }
        if (content.length === 0) continue;

        const uuid = crypto.randomUUID();
        lines.push({
          parentUuid,
          isSidechain: false,
          type: 'assistant',
          message: {
            model: session.model?.id ?? 'claude-sonnet-4-5',
            id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
            type: 'message',
            role: 'assistant',
            content,
            stop_reason: 'end_turn',
            usage: step.usage
              ? {
                  input_tokens: step.usage.input ?? 0,
                  output_tokens: step.usage.output ?? 0,
                  cache_read_input_tokens: step.usage.cacheRead ?? 0,
                  cache_creation_input_tokens: step.usage.cacheWrite ?? 0,
                }
              : undefined,
          },
          uuid,
          timestamp: new Date(turn.endedAt ?? turn.startedAt).toISOString(),
          ...baseMeta,
        });
        parentUuid = uuid;
      }
    }

    await fsp.mkdir(projDir, { recursive: true });
    const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    const tmp = file + '.tmp-' + process.pid;
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, file);

    return {
      ok: true,
      targetId: sessionId,
      location: file,
      records: lines.length,
      warnings: [],
    };
  }
}

export const claudeCodeAdapter = new ClaudeCodeAdapter();
