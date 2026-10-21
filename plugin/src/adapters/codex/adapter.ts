/**
 * adapters/codex/adapter.ts —— Codex 会话适配器
 *
 * 复用现有 `convert/codex-reader.ts` 与 `convert/dsh2codex.ts` 的部分逻辑。
 * 存储：`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` + `state_5.sqlite` 索引
 *
 * Codex rollout 行类型 → UIR：
 *   session_meta       → session 元信息
 *   turn_context       → turn 边界
 *   response_item/message        → text 块
 *   response_item/reasoning      → step.reasoning
 *   response_item/function_call  → tool-call
 *   response_item/function_call_output → tool-result
 *   event_msg/item_completed     → 作为 opaque（UI 渲染源，保真用）
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
import { codexHome } from '../../host/clients.js';
import { dshToCodex } from '../../convert/dsh2codex.js';

export function codexSessionsDir(): string {
  return path.join(codexHome(), 'sessions');
}

function codexDb(): string {
  return path.join(codexHome(), 'state_5.sqlite');
}

/** 递归列 rollout 文件 */
function listRollouts(): string[] {
  const root = codexSessionsDir();
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 6) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/^rollout-.*\.jsonl(\.zst)?$/.test(e.name)) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

/** 读 rollout 文本（支持 .zst） */
function readRolloutText(file: string): string | null {
  try {
    const buf = fs.readFileSync(file);
    const isZstd = buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd;
    if (!isZstd) return buf.toString('utf8');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const zlib = require('node:zlib') as typeof import('node:zlib');
    return zlib.zstdDecompressSync(buf).toString('utf8');
  } catch {
    return null;
  }
}

/** 从文件名提取 thread id */
function threadIdFromFile(file: string): string | null {
  const m = path.basename(file).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  return m ? m[0] : null;
}

export class CodexAdapter implements SessionAdapter {
  readonly capability: AdapterCapability = {
    client: 'codex',
    label: 'Codex',
    canRead: true,
    canWrite: true,
    supportsSubagent: true,
    supportsImage: true,
    supportsFileChange: true,
    supportsBranching: false,
    lossyFields: ['加密内容 encrypted_content（仅占位）', '子代理会话需合并到父会话'],
  };

  probe(): { available: boolean; reason?: string } {
    const root = codexSessionsDir();
    if (!fs.existsSync(root)) {
      return { available: false, reason: `未找到 Codex 会话目录：${root}` };
    }
    return { available: true };
  }

  async list(): Promise<SessionSummary[]> {
    const files = listRollouts();
    // thread id → 最新文件
    const byThread = new Map<string, { file: string; mtime: number }>();
    for (const f of files) {
      const tid = threadIdFromFile(f);
      if (!tid) continue;
      try {
        const st = fs.statSync(f);
        const prev = byThread.get(tid);
        if (!prev || st.mtimeMs > prev.mtime) byThread.set(tid, { file: f, mtime: st.mtimeMs });
      } catch { /* skip */ }
    }

    // 优先用 Codex 官方索引拿标题
    const titleById = new Map<string, string>();
    try {
      const idx = path.join(codexHome(), 'session_index.jsonl');
      if (fs.existsSync(idx)) {
        for (const line of fs.readFileSync(idx, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const o = JSON.parse(line);
            if (o.id && o.thread_name) titleById.set(String(o.id), String(o.thread_name));
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }

    const out: SessionSummary[] = [];
    for (const [tid, rec] of byThread) {
      try {
        const st = fs.statSync(rec.file);
        out.push({
          client: 'codex',
          id: tid,
          title: titleById.get(tid) ?? '(无标题)',
          cwd: '',
          createdAt: st.birthtimeMs,
          updatedAt: rec.mtime,
        });
      } catch { /* skip */ }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async read(opts: ReadOptions): Promise<ReadResult> {
    const files = listRollouts();
    const target = files.find((f) => threadIdFromFile(f) === opts.sessionId)
      ?? files.find((f) => path.basename(f).includes(opts.sessionId));
    if (!target) throw new Error(`未找到 Codex 会话：${opts.sessionId}`);

    const text = readRolloutText(target);
    if (!text) throw new Error(`无法读取 Codex 会话文件：${target}`);

    const rows: any[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip 损坏行 */ }
    }

    const warnings: string[] = [];
    const turns: UirTurn[] = [];
    const opaque: Array<{ kind: string; seq: number; payload: unknown }> = [];
    let current: UirTurn | null = null;
    let step: UirStep | null = null;
    let title = '';
    let cwd = '';
    let createdAt = Date.now();
    let model: UirSession['model'] | undefined;

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

    let seq = 0;
    for (const r of rows) {
      const ts = r.timestamp ? Date.parse(r.timestamp) : Date.now();
      switch (r.type) {
        case 'session_meta': {
          const p = r.payload ?? {};
          cwd = String(p.cwd ?? '');
          createdAt = ts || Date.now();
          model = p.model_provider ? { provider: String(p.model_provider) } : undefined;
          break;
        }
        case 'turn_context': {
          if (current) turns.push(current);
          current = { index: turns.length, startedAt: ts, userMessages: [], steps: [] };
          step = null;
          turns.push(current);
          // 上面的 push 会重复，修正：
          turns.pop();
          current.index = turns.length;
          turns.push(current);
          const p = r.payload ?? {};
          if (p.model) model = { ...(model ?? {}), id: String(p.model) };
          break;
        }
        case 'response_item': {
          const p = r.payload ?? {};
          switch (p.type) {
            case 'message': {
              const t = ensureTurn(ts);
              const content = p.content ?? [];
              const textOut = content
                .filter((c: any) => typeof c?.text === 'string')
                .map((c: any) => c.text).join('\n');
              if (!textOut) break;
              if (p.role === 'user') {
                t.userMessages.push({
                  kind: 'text', role: 'user', text: textOut,
                  tier: classifyText(textOut, { injected: isInjectedTemplate(textOut) }),
                  injected: isInjectedTemplate(textOut),
                });
                if (!title && !isInjectedTemplate(textOut)) title = textOut.replace(/\s+/g, ' ').slice(0, 80);
              } else if (p.role === 'assistant') {
                const s = ensureStep(ts);
                s.blocks.push({
                  kind: 'text', role: 'assistant', text: textOut,
                  tier: classifyText(textOut, { injected: isInjectedTemplate(textOut) }),
                });
              }
              break;
            }
            case 'reasoning': {
              const s = ensureStep(ts);
              const sum = (p.summary ?? []).map((x: any) => x?.text ?? '').join('\n');
              if (sum) s.reasoning = s.reasoning ? `${s.reasoning}\n${sum}` : sum;
              break;
            }
            case 'function_call': {
              const s = ensureStep(ts);
              s.blocks.push({
                kind: 'tool-call',
                callId: String(p.call_id ?? p.id ?? `call-${seq}`),
                name: String(p.name ?? 'tool'),
                args: safeJson(p.arguments),
                rawArgs: typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? {}),
                tier: 'critical',
              });
              break;
            }
            case 'function_call_output': {
              const s = ensureStep(ts);
              const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
              s.blocks.push({
                kind: 'tool-result',
                callId: String(p.call_id ?? `call-${seq}`),
                output: { text: out, originalLength: out.length },
                isError: false,
                tier: 'critical',
              });
              break;
            }
            case 'agent_message': {
              const s = ensureStep(ts);
              const textOut = (p.content ?? []).filter((c: any) => typeof c?.text === 'string').map((c: any) => c.text).join('\n');
              if (textOut) s.blocks.push({ kind: 'text', role: 'assistant', text: textOut, tier: 'high' });
              break;
            }
            default:
              opaque.push({ kind: `response_item/${p.type}`, seq: seq++, payload: p });
              break;
          }
          break;
        }
        case 'event_msg': {
          const p = r.payload ?? {};
          if (p.type === 'thread_name_updated' && p.thread_name) title = String(p.thread_name);
          else if (p.type === 'item_completed') {
            opaque.push({ kind: 'item_completed', seq: seq++, payload: p });
          }
          break;
        }
        default:
          break;
      }
    }

    const session: UirSession = {
      id: `codex-${opts.sessionId}`,
      title: title || '(无标题)',
      cwd,
      createdAt,
      updatedAt: fs.statSync(target).mtimeMs,
      origin: {
        client: 'codex',
        originalId: opts.sessionId,
        raw: { file: target },
      },
      model,
      turns,
      opaque: opaque.length > 0 ? opaque.slice(0, 500) : undefined,
      warnings,
    };
    return { session, warnings };
  }

  async write(session: UirSession, opts: WriteOptions = {}): Promise<WriteResult> {
    // 复用现有 dshToCodex：先把 UIR 转成最小 DSH 事件，再走成熟转换器
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
            message: { role: 'assistant', id: `a-${seq}`, content, source: { kind: 'model', provider: 'codex-bridge', model: session.model?.id ?? 'imported', imported: true } },
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

    const cwd = opts.cwd ?? session.cwd ?? process.cwd();
    const header = {
      version: 4 as const,
      id: `session-codex-${crypto.randomUUID()}`,
      createdAt: session.createdAt,
      isSeeded: false,
      delegationDepth: 0,
      cwd,
      agentPreset: 'standard',
    };

    const conv = dshToCodex({ header, events }, {});
    // thread id 从 header.id 派生（dshToCodex 内部也是这么做的）
    const threadId = header.id.replace(/^session-codex-/, '');

    // 写 canonical 文件名
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const now = new Date();
    const dir = path.join(codexSessionsDir(), String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `rollout-${stamp}-${threadId}.jsonl`);
    await fsp.writeFile(file, conv.jsonl, 'utf8');

    return {
      ok: true,
      targetId: threadId,
      location: file,
      records: conv.jsonl.split('\n').filter(Boolean).length,
      warnings: ['Codex 需重启并注册索引后才会显示该会话'],
    };
  }
}

function safeJson(s: unknown): unknown {
  if (typeof s !== 'string') return s ?? {};
  try { return JSON.parse(s); } catch { return {}; }
}

export const codexAdapter = new CodexAdapter();
