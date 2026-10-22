/**
 * adapters/dsh/adapter.ts —— DSH 会话适配器
 *
 * 复用现有的 `convert/dsh-store.ts`（v4 多帧 zstd 读写）。
 * 存储：~/.dsh/sessions/<projectKey(cwd)>/<sessionId>/session.v4.jsonl.zstd
 *
 * DSH v4 事件模型 → UIR 映射：
 *   turn/start + turn/end        → UirTurn
 *   step/start + step/end        → UirStep
 *   user/message                 → turn.userMessages
 *   assistant/message            → step.blocks (text) + step.reasoning
 *   tool/call + tool/result      → step.blocks (tool-call / tool-result)
 *   session/title                → session.title
 *   subagent/catalog             → opaque
 *   compaction/prune             → opaque
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
import { readDshSessionFile, writeDshSessionFile, listDshSessions } from '../../convert/dsh-store.js';
import { dshHome, dshHome as _dshHome } from '../../host/clients.js';
import { projectKey, encodeSegment } from '../../host/paths.js';
import type { DshEvent, DshHeader } from '../../shared/types.js';

export function dshSessionsRoot(): string {
  return path.join(dshHome(), 'sessions');
}

export class DshAdapter implements SessionAdapter {
  readonly capability: AdapterCapability = {
    client: 'dsh',
    label: 'DeepSeek Harness',
    canRead: true,
    canWrite: true,
    supportsSubagent: true,
    supportsImage: true,
    supportsFileChange: true,
    supportsBranching: false,
    lossyFields: ['加密思考内容（无法解码，仅保留占位）'],
  };

  probe(): { available: boolean; reason?: string } {
    const root = dshSessionsRoot();
    if (!fs.existsSync(root)) {
      return { available: false, reason: `未找到 DSH 会话目录：${root}` };
    }
    return { available: true };
  }

  async list(): Promise<SessionSummary[]> {
    const rows = await listDshSessions(dshSessionsRoot());
    const out: SessionSummary[] = [];
    for (const r of rows) {
      try {
        const s = readDshSessionFile(r.filePath);
        let title = '';
        let turns = 0;
        let messages = 0;
        for (const e of s.events) {
          if (e.type === 'session/title') title = String((e.data as any)?.title ?? '');
          if (e.type === 'turn/start') turns++;
          if (e.type === 'user/message' || e.type === 'assistant/message') messages++;
        }
        // 无标题时用首条用户消息
        if (!title) {
          for (const e of s.events) {
            if (e.type === 'user/message') {
              const text = ((e.data as any)?.content ?? [])
                .filter((b: any) => typeof b?.text === 'string')
                .map((b: any) => b.text).join(' ');
              if (text && !isInjectedTemplate(text)) { title = text.replace(/\s+/g, ' ').slice(0, 80); break; }
            }
          }
        }
        out.push({
          client: 'dsh',
          id: s.header.id,
          title: title || (messages === 0 ? '(空会话)' : '(无标题)'),
          cwd: s.header.cwd ?? '',
          createdAt: s.header.createdAt,
          updatedAt: r.mtime,
          turns,
        });
      } catch {
        // 损坏会话跳过
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async read(opts: ReadOptions): Promise<ReadResult> {
    const rows = await listDshSessions(dshSessionsRoot());
    const row = rows.find((r) => r.id === opts.sessionId)
      ?? rows.find((r) => r.id.replace(/^session-/, '') === opts.sessionId.replace(/^session-/, ''));
    if (!row) throw new Error(`未找到 DSH 会话：${opts.sessionId}`);

    const s = readDshSessionFile(row.filePath);
    const warnings: string[] = [];
    const turns: UirTurn[] = [];
    const opaque: Array<{ kind: string; seq: number; payload: unknown }> = [];
    let title = '';
    let current: UirTurn | null = null;
    let step: UirStep | null = null;
    let modelInfo: UirSession['model'] | undefined;

    for (const e of s.events) {
      const d = (e.data ?? {}) as any;
      switch (e.type) {
        case 'session/title':
          title = String(d.title ?? '');
          break;

        case 'turn/start':
          if (current) turns.push(current);
          current = {
            index: turns.length,
            startedAt: e.time,
            userMessages: [],
            steps: [],
          };
          step = null;
          break;

        case 'step/start':
          if (current) {
            step = { index: current.steps.length, blocks: [] };
            current.steps.push(step);
          }
          break;

        case 'user/message': {
          if (!current) break;
          const src = d.source ?? {};
          if (src.kind === 'agent-message') {
            // 子代理中继消息：作为普通文本块保留
            const text = (d.content ?? []).filter((b: any) => typeof b?.text === 'string').map((b: any) => b.text).join('\n');
            if (text) current.userMessages.push({ kind: 'text', role: 'user', text, tier: 'high' });
            break;
          }
          for (const b of d.content ?? []) {
            if (b?.type === 'text' && typeof b.text === 'string') {
              current.userMessages.push({
                kind: 'text', role: 'user', text: b.text,
                tier: classifyText(b.text, { injected: isInjectedTemplate(b.text) }),
                injected: isInjectedTemplate(b.text),
              });
            }
          }
          break;
        }

        case 'assistant/message': {
          if (!current) break;
          if (!step) {
            step = { index: current.steps.length, blocks: [] };
            current.steps.push(step);
          }
          const blocks: any[] = d.message?.content ?? [];
          const reasoning = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text).filter(Boolean).join('\n');
          if (reasoning) step.reasoning = step.reasoning ? `${step.reasoning}\n${reasoning}` : reasoning;
          for (const b of blocks) {
            if (b?.type === 'text' && typeof b.text === 'string') {
              step.blocks.push({
                kind: 'text', role: 'assistant', text: b.text,
                tier: classifyText(b.text, { injected: isInjectedTemplate(b.text) }),
                injected: isInjectedTemplate(b.text),
              });
            } else if (b?.type === 'tool-call') {
              step.blocks.push({
                kind: 'tool-call',
                callId: String(b.id ?? `call-${e.seq}`),
                name: String(b.name ?? 'tool'),
                args: safeJson(b.arguments),
                rawArgs: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {}),
                tier: 'critical',
              });
            }
          }
          break;
        }

        case 'tool/result': {
          if (!current || !step) break;
          const m = d.message ?? {};
          const out = (m.content ?? []).filter((b: any) => typeof b?.text === 'string').map((b: any) => b.text).join('\n');
          step.blocks.push({
            kind: 'tool-result',
            callId: String(m.toolCallId ?? m.source?.callId ?? `call-${e.seq}`),
            output: { text: out, originalLength: out.length },
            isError: m.isError === true,
            tier: 'critical',
          });
          break;
        }

        case 'model/selection':
          modelInfo = {
            provider: d.provider ? String(d.provider) : undefined,
            id: d.model ? String(d.model) : undefined,
          };
          break;

        case 'subagent/catalog':
        case 'compaction/prune':
        case 'compaction/summary':
        case 'codex-bridge/meta':
          opaque.push({ kind: e.type, seq: e.seq, payload: d });
          break;

        default:
          break;
      }
    }
    if (current) turns.push(current);

    const session: UirSession = {
      id: `dsh-${s.header.id}`,
      title: title || '(无标题)',
      cwd: s.header.cwd ?? '',
      createdAt: s.header.createdAt,
      updatedAt: row.mtime,
      origin: {
        client: 'dsh',
        originalId: s.header.id,
        raw: {
          isSeeded: s.header.isSeeded,
          delegationDepth: s.header.delegationDepth,
          agentPreset: s.header.agentPreset,
          parentSession: s.header.parentSession,
        },
      },
      parent: s.header.parentSession
        ? { client: 'dsh', threadId: String(s.header.parentSession) }
        : undefined,
      model: modelInfo,
      turns,
      opaque: opaque.length > 0 ? opaque : undefined,
      warnings,
    };
    return { session, warnings };
  }

  async write(session: UirSession, opts: WriteOptions = {}): Promise<WriteResult> {
    const cwd = opts.cwd ?? session.cwd ?? process.cwd();
    const sessionId = session.origin.client === 'dsh'
      ? session.origin.originalId
      : `session-${crypto.randomUUID()}`;

    // UIR → DSH v4 事件
    const events: DshEvent[] = [];
    let seq = 0;
    const push = (type: string, data: Record<string, unknown>, time: number, extra: Record<string, unknown> = {}) => {
      events.push({ type, seq: seq++, time, data, ...extra } as DshEvent);
    };

    for (const turn of session.turns) {
      push('turn/start', { turn: turn.index + 1 }, turn.startedAt);
      push('step/start', { turn: turn.index + 1, step: 1 }, turn.startedAt);

      for (const b of turn.userMessages) {
        if (b.kind !== 'text') continue;
        push('user/message', {
          role: 'user',
          id: `u-${seq}`,
          content: [{ type: 'text', text: b.text }],
        }, turn.startedAt, { surfaceOp: 'append' });
      }

      for (const step of turn.steps) {
        if (step.reasoning) {
          push('assistant/message', {
            turn: turn.index + 1, step: 1,
            message: {
              role: 'assistant', id: `a-${seq}`,
              content: [{ type: 'reasoning', text: step.reasoning }],
              source: { kind: 'model', provider: 'dsh-bridge', model: session.model?.id ?? 'imported', imported: true },
            },
            stream: [],
          }, turn.endedAt ?? turn.startedAt, { surfaceOp: 'append' });
        }
        const textBlocks = step.blocks.filter((b) => b.kind === 'text' && b.role === 'assistant');
        const toolCalls = step.blocks.filter((b) => b.kind === 'tool-call');
        if (textBlocks.length > 0 || toolCalls.length > 0) {
          const content: any[] = [];
          for (const b of textBlocks) content.push({ type: 'text', text: (b as any).text });
          for (const b of toolCalls) {
            content.push({ type: 'tool-call', id: (b as any).callId, name: (b as any).name, arguments: (b as any).rawArgs ?? JSON.stringify((b as any).args ?? {}) });
          }
          push('assistant/message', {
            turn: turn.index + 1, step: 1,
            message: {
              role: 'assistant', id: `a-${seq}`,
              content,
              source: { kind: 'model', provider: 'dsh-bridge', model: session.model?.id ?? 'imported', imported: true },
            },
            stream: [],
          }, turn.endedAt ?? turn.startedAt, { surfaceOp: 'append' });

          for (const b of toolCalls) {
            push('tool/call', {
              turn: turn.index + 1, step: 1,
              callId: (b as any).callId,
              name: (b as any).name,
              arguments: (b as any).rawArgs ?? JSON.stringify((b as any).args ?? {}),
            }, turn.endedAt ?? turn.startedAt);
          }
        }
        for (const b of step.blocks) {
          if (b.kind !== 'tool-result') continue;
          push('tool/result', {
            turn: turn.index + 1, step: 1,
            message: {
              role: 'tool', id: `tr-${seq}`,
              toolCallId: b.callId,
              source: { kind: 'tool', callId: b.callId },
              content: [{ type: 'text', text: b.output.text }],
              isError: b.isError,
            },
          }, turn.endedAt ?? turn.startedAt, { surfaceOp: 'append' });
        }
      }

      push('step/end', { turn: turn.index + 1, step: 1 }, turn.endedAt ?? turn.startedAt);
      push('turn/end', { turn: turn.index + 1, reason: { kind: 'completed' } }, turn.endedAt ?? turn.startedAt);
    }

    // 标题（必须：source.kind==='user' 时 messageSeqs 必须为空）
    const titleText = (opts.title ?? session.title ?? '导入会话').slice(0, 200);
    push('session/title', {
      title: titleText,
      messageSeqs: [],
      source: { kind: 'user' },
    }, session.createdAt);

    // 模型选择
    if (session.model?.id) {
      push('model/selection', {
        provider: session.model.provider ?? 'dsh-bridge',
        model: session.model.id,
      }, session.createdAt);
    }

    const header: DshHeader = {
      version: 4,
      id: sessionId,
      createdAt: session.createdAt,
      isSeeded: false,
      delegationDepth: 0,
      cwd,
      agentPreset: 'standard',
    };

    // 写入路径：sessions/<projectKey(cwd)>/<encodeSegment(id)>/
    const targetDir = path.join(dshSessionsRoot(), projectKey(cwd), encodeSegment(sessionId));
    const file = await writeDshSessionFile({ header, events }, targetDir);

    // ★ 注册到 workspace.json —— 否则 DSH 的会话列表看不到它
    const warnings: string[] = [];
    try {
      await registerToWorkspace(sessionId, cwd);
      warnings.push('DSH 需要重启后才会在工作区列表看到该会话');
    } catch (e) {
      warnings.push(`会话已写入，但注册到工作区失败：${String((e as Error)?.message ?? e)}（重启 DSH 后可能仍不可见）`);
    }

    return {
      ok: true,
      targetId: sessionId,
      location: file,
      records: events.length,
      warnings,
    };
  }
}

/**
 * 把新会话注册进 DSH 的 workspace.json。
 *
 * DSH 的会话列表来自 `storages/workspace.json` 的 `tables.workspaces.<id>.sessionIds`，
 * 而不是扫描 sessions 目录。不注册的话，文件在磁盘上但列表看不到。
 */
async function registerToWorkspace(sessionId: string, cwd: string): Promise<void> {
  const file = path.join(dshHome(), 'storages', 'workspace.json');
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return;   // 没有 workspace.json（未初始化工作区），跳过
  }
  const data = JSON.parse(raw);
  const tables = data?.tables?.workspaces;
  if (!tables) return;

  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();
  const target = norm(cwd);

  for (const key of Object.keys(tables)) {
    const ws = tables[key];
    if (typeof ws?.path !== 'string') continue;
    if (norm(ws.path) !== target) continue;

    const ids: string[] = Array.isArray(ws.sessionIds) ? ws.sessionIds : [];
    if (ids.includes(sessionId)) return;
    ws.sessionIds = [sessionId, ...ids];
    ws.updatedAt = new Date().toISOString();
    await fsp.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return;
  }
  // 目标 cwd 没有对应工作区：DSH 会在下次启动时按 header.cwd 自动归类（若已初始化则不会）
}

function safeJson(s: unknown): unknown {
  if (typeof s !== 'string') return s ?? {};
  try { return JSON.parse(s); } catch { return {}; }
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const dshAdapter = new DshAdapter();
