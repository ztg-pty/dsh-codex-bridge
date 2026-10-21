/**
 * adapters/workbuddy/adapter.ts —— WorkBuddy 会话适配器
 *
 * 复用现有 `convert/dsh2wb.ts`（UIR → WorkBuddy 行）与 `host/wb-store.ts`（持久化）。
 * 存储：~/.workbuddy-ai/workbuddy.db（sessions/workspaces 表）+ projects/<cwd编码>/<id>.jsonl
 *
 * JSONL 行类型 → UIR：
 *   session-meta        → session 元信息
 *   message (user)      → turn.userMessages
 *   message (assistant) → step.blocks (text)
 *   reasoning           → step.reasoning
 *   function_call       → tool-call
 *   function_call_result→ tool-result
 *   ai-title            → session.title
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  SessionAdapter, AdapterCapability, ReadOptions, ReadResult,
  WriteOptions, WriteResult, SessionSummary, UirSession, UirTurn, UirStep,
} from '../../uir/types.js';
import { classifyText, isInjectedTemplate } from '../../uir/helpers.js';
import { workbuddyHome, zcodeHome } from '../../host/clients.js';
import { writeWorkbuddySession, workbuddyAvailable, workbuddyDbFile } from '../../host/wb-store.js';

function projectsDir(): string {
  return path.join(workbuddyHome(), 'projects');
}

/** cwd → 项目目录名（盘符小写，冒号与斜杠都变 -） */
function encodeCwdDir(cwd: string): string {
  return cwd.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => d.toLowerCase()).replace(/[/:]/g, '-');
}

/** 动态加载 node:sqlite */
async function openDb(readOnly: boolean): Promise<any> {
  const mod: any = await import('node:sqlite' as any);
  return readOnly
    ? new mod.DatabaseSync(workbuddyDbFile(), { readOnly: true })
    : new mod.DatabaseSync(workbuddyDbFile());
}

export class WorkbuddyAdapter implements SessionAdapter {
  readonly capability: AdapterCapability = {
    client: 'workbuddy',
    label: 'WorkBuddy',
    canRead: true,
    canWrite: true,
    supportsSubagent: false,
    supportsImage: true,
    supportsFileChange: true,
    supportsBranching: false,
    lossyFields: ['子代理结构（无对应概念）', '客户端私有 URI（如 zcode-artifact）'],
  };

  probe(): { available: boolean; reason?: string } {
    if (!workbuddyAvailable()) {
      return { available: false, reason: `未找到 WorkBuddy 数据库：${workbuddyDbFile()}` };
    }
    return { available: true };
  }

  async list(): Promise<SessionSummary[]> {
    const db = await openDb(true);
    try {
      const rows = db.prepare(
        'SELECT id, title, cwd, created_at, updated_at FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC',
      ).all();
      return rows.map((r: any) => ({
        client: 'workbuddy' as const,
        id: String(r.id),
        title: String(r.title ?? '(无标题)'),
        cwd: String(r.cwd ?? ''),
        createdAt: Number(r.created_at ?? 0),
        updatedAt: Number(r.updated_at ?? 0),
      }));
    } finally {
      db.close();
    }
  }

  /** 找到会话的 JSONL 文件 */
  private findJsonl(sessionId: string): string | null {
    const root = projectsDir();
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(root); } catch { return null; }
    for (const d of dirs) {
      const f = path.join(root, d, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
    return null;
  }

  async read(opts: ReadOptions): Promise<ReadResult> {
    const db = await openDb(true);
    let row: any;
    try {
      row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(opts.sessionId);
    } finally {
      db.close();
    }
    if (!row) throw new Error(`未找到 WorkBuddy 会话：${opts.sessionId}`);

    const file = this.findJsonl(opts.sessionId);
    if (!file) throw new Error(`未找到 WorkBuddy 会话文件（会话 ${opts.sessionId}）`);

    const lines: any[] = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { lines.push(JSON.parse(line)); } catch { /* skip */ }
    }

    const warnings: string[] = [];
    const turns: UirTurn[] = [];
    const opaque: Array<{ kind: string; seq: number; payload: unknown }> = [];
    let current: UirTurn | null = null;
    let step: UirStep | null = null;
    let title = String(row.title ?? '');
    let seq = 0;
    const callNames = new Map<string, string>();

    const ensureTurn = (ts: number) => {
      if (!current) {
        current = { index: turns.length, startedAt: ts, userMessages: [], steps: [] };
        turns.push(current);
        step = null;
      }
      return current;
    };
    const ensureStep = (ts: number) => {
      const t = ensureTurn(ts);
      if (!step) {
        step = { index: t.steps.length, blocks: [] };
        t.steps.push(step);
      }
      return step;
    };

    for (const l of lines) {
      const ts = Number(l.timestamp ?? Date.now());
      switch (l.type) {
        case 'session-meta':
          break;
        case 'ai-title':
          if (l.aiTitle) title = String(l.aiTitle);
          break;
        case 'message': {
          const content = Array.isArray(l.content)
            ? l.content.filter((c: any) => typeof c?.text === 'string').map((c: any) => c.text).join('\n')
            : String(l.content ?? '');
          if (!content) break;
          if (l.role === 'user') {
            const t = ensureTurn(ts);
            t.userMessages.push({
              kind: 'text', role: 'user', text: content,
              tier: classifyText(content, { injected: isInjectedTemplate(content) }),
              injected: isInjectedTemplate(content),
            });
            if (!title && !isInjectedTemplate(content)) title = content.replace(/\s+/g, ' ').slice(0, 80);
          } else if (l.role === 'assistant') {
            const s = ensureStep(ts);
            s.blocks.push({
              kind: 'text', role: 'assistant', text: content,
              tier: classifyText(content, { injected: isInjectedTemplate(content) }),
            });
          }
          break;
        }
        case 'reasoning': {
          const s = ensureStep(ts);
          const txt = Array.isArray(l.rawContent)
            ? l.rawContent.filter((c: any) => typeof c?.text === 'string').map((c: any) => c.text).join('\n')
            : String(l.content ?? '');
          if (txt) s.reasoning = s.reasoning ? `${s.reasoning}\n${txt}` : txt;
          break;
        }
        case 'function_call': {
          const s = ensureStep(ts);
          callNames.set(String(l.callId), String(l.name ?? 'tool'));
          s.blocks.push({
            kind: 'tool-call',
            callId: String(l.callId ?? `call-${seq}`),
            name: String(l.name ?? 'tool'),
            args: safeJson(l.arguments),
            rawArgs: typeof l.arguments === 'string' ? l.arguments : JSON.stringify(l.arguments ?? {}),
            tier: 'critical',
          });
          break;
        }
        case 'function_call_result': {
          const s = ensureStep(ts);
          const out = typeof l.output === 'object' && l.output
            ? String((l.output as any).text ?? JSON.stringify(l.output))
            : String(l.output ?? '');
          s.blocks.push({
            kind: 'tool-result',
            callId: String(l.callId ?? `call-${seq}`),
            name: callNames.get(String(l.callId)),
            output: { text: out, originalLength: out.length },
            isError: l.status === 'failed' || l.status === 'error',
            tier: 'critical',
          });
          break;
        }
        default:
          opaque.push({ kind: String(l.type), seq: seq++, payload: l });
          break;
      }
    }

    const session: UirSession = {
      id: `wb-${opts.sessionId}`,
      title: title || '(无标题)',
      cwd: String(row.cwd ?? ''),
      createdAt: Number(row.created_at ?? Date.now()),
      updatedAt: Number(row.updated_at ?? Date.now()),
      origin: {
        client: 'workbuddy',
        originalId: opts.sessionId,
        raw: { file, model: row.model, userId: row.user_id },
      },
      model: row.model ? { id: String(row.model) } : undefined,
      turns,
      opaque: opaque.length > 0 ? opaque.slice(0, 200) : undefined,
      warnings,
    };
    return { session, warnings };
  }

  async write(session: UirSession, opts: WriteOptions = {}): Promise<WriteResult> {
    // 复用 host/wb-store 的 writeWorkbuddySession（它接收 DSH 会话结构）
    // 这里把 UIR 转成最小 DSH 事件结构
    const events: any[] = [];
    let seq = 0;
    const push = (type: string, data: any, time: number, extra: any = {}) => {
      events.push({ type, seq: seq++, time, data, ...extra });
    };
    for (const turn of session.turns) {
      push('turn/start', { turn: turn.index + 1 }, turn.startedAt);
      push('step/start', { turn: turn.index + 1, step: 1 }, turn.startedAt);
      for (const b of turn.userMessages) {
        if (b.kind !== 'text') continue;
        push('user/message', { role: 'user', id: `u-${seq}`, content: [{ type: 'text', text: b.text }] }, turn.startedAt, { surfaceOp: 'append' });
      }
      for (const step of turn.steps) {
        const content: any[] = [];
        if (step.reasoning) content.push({ type: 'reasoning', text: step.reasoning });
        for (const b of step.blocks) {
          if (b.kind === 'text' && b.role === 'assistant') content.push({ type: 'text', text: b.text });
          else if (b.kind === 'tool-call') content.push({ type: 'tool-call', id: b.callId, name: b.name, arguments: b.rawArgs ?? JSON.stringify(b.args ?? {}) });
        }
        if (content.length > 0) {
          push('assistant/message', {
            turn: turn.index + 1, step: 1,
            message: { role: 'assistant', id: `a-${seq}`, content, source: { kind: 'model', provider: 'wb-bridge', model: session.model?.id ?? 'imported', imported: true } },
            stream: [],
          }, turn.endedAt ?? turn.startedAt, { surfaceOp: 'append' });
          for (const b of step.blocks) {
            if (b.kind === 'tool-call') {
              push('tool/call', { turn: turn.index + 1, step: 1, callId: b.callId, name: b.name, arguments: b.rawArgs ?? JSON.stringify(b.args ?? {}) }, turn.endedAt ?? turn.startedAt);
            }
          }
        }
        for (const b of step.blocks) {
          if (b.kind !== 'tool-result') continue;
          push('tool/result', {
            turn: turn.index + 1, step: 1,
            message: { role: 'tool', id: `tr-${seq}`, toolCallId: b.callId, source: { kind: 'tool', callId: b.callId }, content: [{ type: 'text', text: b.output.text }], isError: b.isError },
          }, turn.endedAt ?? turn.startedAt, { surfaceOp: 'append' });
        }
      }
      push('step/end', { turn: turn.index + 1, step: 1 }, turn.endedAt ?? turn.startedAt);
      push('turn/end', { turn: turn.index + 1, reason: { kind: 'completed' } }, turn.endedAt ?? turn.startedAt);
    }
    push('session/title', { title: (opts.title ?? session.title ?? '导入会话').slice(0, 200), messageSeqs: [], source: { kind: 'user' } }, session.createdAt);

    const header = {
      version: 4 as const,
      id: `session-wb-${crypto.randomUUID()}`,
      createdAt: session.createdAt,
      isSeeded: false,
      delegationDepth: 0,
      cwd: opts.cwd ?? session.cwd ?? process.cwd(),
      agentPreset: 'standard',
    };

    const w = await writeWorkbuddySession({ header, events } as any, {
      title: opts.title ?? session.title,
      cwd: opts.cwd ?? session.cwd,
    });

    return {
      ok: w.ok,
      targetId: w.sessionId,
      location: w.jsonlPath,
      records: w.rows,
      warnings: ['WorkBuddy 需重启后才会在会话列表看到该会话'],
    };
  }
}

function safeJson(s: unknown): unknown {
  if (typeof s !== 'string') return s ?? {};
  try { return JSON.parse(s); } catch { return {}; }
}

export const workbuddyAdapter = new WorkbuddyAdapter();
