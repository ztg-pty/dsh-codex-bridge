/**
 * adapters/zcode/adapter.ts —— Zcode 会话适配器
 *
 * 存储格式（实测 ~/.zcode/cli/db/db.sqlite）：
 *   session(id, parent_id, title, directory, time_created, time_updated, ...)   126 行
 *   message(id, session_id, data, sequence)                                    24584 行
 *   part(id, message_id, session_id, data, sequence)                           107370 行
 *
 * message.data（JSON）: { role, time:{created,completed}, modelID, providerID, mode, agent,
 *                         path:{cwd,root}, tokens:{...}, semantics:{...}, anchor:{turnId} }
 * part.data（JSON）: { type: 'text'|'reasoning'|'tool'|'step-start'|'step-finish'|'timeline'|'file', ... }
 *   - text:      { text, time:{start,end} }
 *   - reasoning: { text }
 *   - tool:      { callID, tool, state:{status,input,output,title}, time }
 *   - step-finish: { reason, cost, tokens:{...} }
 *   - timeline:  { timelineType, fromModel, toModel }
 *   - file:      { mime, url, metadata }
 *
 * ★ 安全：Zcode 数据库有 400MB+ 且进程可能正在运行。
 *   读取用 readOnly；写入前必须备份，且使用 WAL 并发写。
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
import { zcodeHome } from '../../host/clients.js';

export function zcodeDbFile(): string {
  return path.join(zcodeHome(), 'cli', 'db', 'db.sqlite');
}

/** 动态加载 node:sqlite */
async function openDb(readOnly: boolean): Promise<any> {
  const mod: any = await import('node:sqlite' as any);
  // 注意：DatabaseSync 的第二参数不能传 undefined，必须省略或传对象
  return readOnly
    ? new mod.DatabaseSync(zcodeDbFile(), { readOnly: true })
    : new mod.DatabaseSync(zcodeDbFile());
}

function safeJson(s: unknown): any {
  if (typeof s !== 'string') return s ?? null;
  try { return JSON.parse(s); } catch { return null; }
}

/** 把 part.data 转成 UIR block */
function partToBlock(part: any): UirBlock | null {
  if (!part || typeof part !== 'object') return null;
  switch (part.type) {
    case 'text': {
      const text = String(part.text ?? '');
      if (!text) return null;
      return {
        kind: 'text',
        role: 'assistant',      // 调用方按 message.role 覆盖
        text,
        tier: classifyText(text, { injected: isInjectedTemplate(text) }),
        injected: isInjectedTemplate(text),
      };
    }
    case 'reasoning': {
      const text = String(part.text ?? '');
      if (!text) return null;
      return { kind: 'reasoning', text, tier: 'medium' };
    }
    case 'tool': {
      const callId = String(part.callID ?? part.id ?? crypto.randomUUID());
      const state = part.state ?? {};
      const blocks: UirBlock[] = [];
      blocks.push({
        kind: 'tool-call',
        callId,
        name: String(part.tool ?? 'tool'),
        args: state.input ?? {},
        rawArgs: JSON.stringify(state.input ?? {}),
        tier: 'critical',
      });
      if (state.output !== undefined) {
        const out = typeof state.output === 'string' ? state.output : JSON.stringify(state.output);
        blocks.push({
          kind: 'tool-result',
          callId,
          name: String(part.tool ?? 'tool'),
          output: { text: out, originalLength: out.length },
          isError: state.status === 'error' || state.status === 'failed',
          tier: 'critical',
        });
      }
      // 返回第一个，后续由调用方处理（这里用数组会破坏接口，故只返回 call）
      return blocks[0];
    }
    case 'file': {
      return {
        kind: 'image',
        mime: String(part.mime ?? 'application/octet-stream'),
        ref: String(part.url ?? ''),
        refKind: 'client-uri',
        tier: 'high',
      };
    }
    default:
      return null;   // step-start / step-finish / timeline 不产生内容块
  }
}

export class ZcodeAdapter implements SessionAdapter {
  readonly capability: AdapterCapability = {
    client: 'zcode',
    label: 'Zcode',
    canRead: true,
    canWrite: true,
    supportsSubagent: true,      // session.parent_id
    supportsImage: true,         // part type=file
    supportsFileChange: false,
    supportsBranching: false,
    lossyFields: ['timeline 事件（模型切换记录）', 'zcode-artifact:// 图片引用（跨端失效）'],
  };

  probe(): { available: boolean; reason?: string } {
    const db = zcodeDbFile();
    if (!fs.existsSync(db)) {
      return { available: false, reason: `未找到 Zcode 数据库：${db}` };
    }
    return { available: true };
  }

  async list(): Promise<SessionSummary[]> {
    const db = await openDb(true);
    try {
      const rows = db.prepare(`
        SELECT s.id, s.title, s.directory, s.time_created, s.time_updated, s.parent_id,
               (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS msg_count
        FROM session s
        WHERE s.time_deleted IS NULL
        ORDER BY s.time_updated DESC
      `).all();
      return rows.map((r: any) => ({
        client: 'zcode' as const,
        id: String(r.id),
        title: String(r.title ?? '(无标题)'),
        cwd: String(r.directory ?? ''),
        createdAt: Number(r.time_created ?? 0),
        updatedAt: Number(r.time_updated ?? 0),
        turns: Math.floor(Number(r.msg_count ?? 0) / 2),
      }));
    } finally {
      db.close();
    }
  }

  async read(opts: ReadOptions): Promise<ReadResult> {
    const db = await openDb(true);
    const warnings: string[] = [];
    try {
      const sess = db.prepare('SELECT * FROM session WHERE id = ?').get(opts.sessionId);
      if (!sess) throw new Error(`未找到 Zcode 会话：${opts.sessionId}`);

      // 模型信息在 session_entry 表的 runtime/model_selection 记录里
      let modelInfo: { provider?: string; id?: string; variant?: string } | undefined;
      try {
        const entry = db.prepare(
          "SELECT data FROM session_entry WHERE session_id = ? AND type = 'runtime/model_selection' LIMIT 1",
        ).get(opts.sessionId);
        if (entry?.data) {
          const d = safeJson(entry.data);
          // 实测结构：{ modelSelection: { providerId, modelId, options: { reasoningLevel } } }
          const ms = d?.modelSelection ?? d;
          if (ms) {
            modelInfo = {
              provider: ms.providerId ? String(ms.providerId) : undefined,
              id: ms.modelId ? String(ms.modelId) : undefined,
              variant: ms.options?.reasoningLevel ? String(ms.options.reasoningLevel) : undefined,
            };
          }
        }
      } catch {
        // session_entry 表可能不存在（旧版本），忽略
      }

      const messages = db.prepare(
        'SELECT * FROM message WHERE session_id = ? ORDER BY sequence ASC, time_created ASC',
      ).all(opts.sessionId);

      const parts = db.prepare(
        'SELECT * FROM part WHERE session_id = ? ORDER BY sequence ASC, time_created ASC',
      ).all(opts.sessionId);

      // 按 message_id 分组 parts
      const partsByMsg = new Map<string, any[]>();
      for (const p of parts) {
        const mid = String(p.message_id);
        if (!partsByMsg.has(mid)) partsByMsg.set(mid, []);
        partsByMsg.get(mid)!.push(safeJson(p.data));
      }

      const turns: UirTurn[] = [];
      let current: UirTurn | null = null;
      let step: UirStep | null = null;
      let title = String(sess.title ?? '');

      for (const m of messages) {
        const md = safeJson(m.data) ?? {};
        const role = String(md.role ?? '');
        const msgParts = partsByMsg.get(String(m.id)) ?? [];

        if (role === 'user') {
          if (current) turns.push(current);
          current = {
            index: turns.length,
            startedAt: Number(md.time?.created ?? m.time_created ?? Date.now()),
            endedAt: Number(md.time?.completed ?? 0) || undefined,
            userMessages: [],
            steps: [],
            rawId: String(m.id),
          };
          step = { index: 0, blocks: [], rawId: String(m.id) };
          current.steps.push(step);

          for (const p of msgParts) {
            const b = partToBlock(p);
            if (b && b.kind === 'text') {
              b.role = 'user';
              const real = !b.injected;
              current.userMessages.push(b);
              if (real && !title) title = b.text.replace(/\s+/g, ' ').slice(0, 80);
            }
          }
          continue;
        }

        if (role === 'assistant' && current && step) {
          // 用量
          const tk = md.tokens;
          if (tk) {
            step.usage = {
              input: Number(tk.input ?? 0) || undefined,
              output: Number(tk.output ?? 0) || undefined,
              reasoning: Number(tk.reasoning ?? 0) || undefined,
              cacheRead: Number(tk.cache?.read ?? 0) || undefined,
              cacheWrite: Number(tk.cache?.write ?? 0) || undefined,
            };
          }
          for (const p of msgParts) {
            if (!p) continue;
            if (p.type === 'reasoning') {
              const text = String(p.text ?? '');
              if (text) step.reasoning = step.reasoning ? `${step.reasoning}\n${text}` : text;
              continue;
            }
            if (p.type === 'tool') {
              const callId = String(p.callID ?? crypto.randomUUID());
              const state = p.state ?? {};
              step.blocks.push({
                kind: 'tool-call', callId,
                name: String(p.tool ?? 'tool'),
                args: state.input ?? {},
                rawArgs: JSON.stringify(state.input ?? {}),
                tier: 'critical',
              });
              if (state.output !== undefined) {
                const out = typeof state.output === 'string' ? state.output : JSON.stringify(state.output);
                step.blocks.push({
                  kind: 'tool-result', callId,
                  name: String(p.tool ?? 'tool'),
                  output: { text: out, originalLength: out.length },
                  isError: state.status === 'error' || state.status === 'failed',
                  tier: 'critical',
                });
              }
              continue;
            }
            const b = partToBlock(p);
            if (b) step.blocks.push(b);
          }
          continue;
        }
      }
      if (current) turns.push(current);

      const session: UirSession = {
        id: `zc-${opts.sessionId}`,
        title: title || '(无标题)',
        cwd: String(sess.directory ?? ''),
        createdAt: Number(sess.time_created ?? Date.now()),
        updatedAt: Number(sess.time_updated ?? Date.now()),
        origin: {
          client: 'zcode',
          originalId: opts.sessionId,
          clientVersion: sess.version ? String(sess.version) : undefined,
          raw: { parentId: sess.parent_id, permission: safeJson(sess.permission) },
        },
        parent: sess.parent_id
          ? { client: 'zcode', threadId: String(sess.parent_id) }
          : undefined,
        model: modelInfo,
        turns,
        warnings,
      };
      return { session, warnings };
    } finally {
      db.close();
    }
  }

  async write(session: UirSession, opts: WriteOptions = {}): Promise<WriteResult> {
    const dbFile = zcodeDbFile();

    // ★ 写入前强制备份（Zcode 数据库 400MB+，且可能有活跃写入）
    const backupDir = path.join(zcodeHome(), 'cli', 'db', 'dsh-bridge-backups');
    await fsp.mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFile = path.join(backupDir, `db-${stamp}.sqlite`);
    await fsp.copyFile(dbFile, backupFile);

    const db = await openDb(false);
    const sessionId = `sess_${crypto.randomUUID()}`;
    const cwd = opts.cwd ?? session.cwd ?? process.cwd();
    const now = Date.now();
    const title = (opts.title ?? session.title ?? '导入会话').slice(0, 200);

    try {
      // 项目 id（沿用 Zcode 的编码风格）
      const projectId = `proj_${cwd.replace(/[\\/:]/g, '-').toLowerCase()}`;

      db.prepare(`
        INSERT INTO session (id, project_id, workspace_id, parent_id, slug, directory, path,
                             title, version, time_created, time_updated, title_source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        // title_source 受 CHECK 约束：只允许 default / first_input / generated / custom
        sessionId, projectId, null, null, sessionId, cwd, cwd,
        title, '0.16.5', session.createdAt, now, 'custom',
      );

      let msgSeq = 0;
      let partSeq = 0;
      const insertMsg = db.prepare(
        'INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)',
      );
      const insertPart = db.prepare(
        'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)',
      );

      for (const turn of session.turns) {
        // 用户消息
        const userText = turn.userMessages
          .filter((b) => b.kind === 'text')
          .map((b: any) => b.text).join('\n');
        if (userText) {
          const mid = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}_message`;
          insertMsg.run(mid, sessionId, turn.startedAt, turn.startedAt, JSON.stringify({
            role: 'user',
            time: { created: turn.startedAt },
            path: { cwd, root: cwd },
            semantics: { origin: 'real_user', kind: 'user_prompt' },
            anchor: { turnId: `turn_${crypto.randomUUID()}` },
          }), msgSeq++);

          insertPart.run(
            `part_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
            mid, sessionId, turn.startedAt, turn.startedAt,
            JSON.stringify({ type: 'text', text: userText, time: { start: turn.startedAt, end: turn.startedAt } }),
            partSeq++,
          );
        }

        // 助手消息
        for (const step of turn.steps) {
          const mid = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}_message`;
          const ts = turn.endedAt ?? turn.startedAt;
          insertMsg.run(mid, sessionId, ts, ts, JSON.stringify({
            role: 'assistant',
            time: { created: ts, completed: ts },
            modelID: session.model?.id ?? 'GLM-5.3-Flash',
            providerID: session.model?.provider ?? 'builtin:zai-start-plan',
            mode: 'craft',
            agent: 'zcode-agent',
            path: { cwd, root: cwd },
            tokens: step.usage ? {
              input: step.usage.input ?? 0,
              output: step.usage.output ?? 0,
              reasoning: step.usage.reasoning ?? 0,
              cache: { read: step.usage.cacheRead ?? 0, write: step.usage.cacheWrite ?? 0 },
            } : undefined,
            semantics: { origin: 'system', kind: 'assistant_message' },
          }), msgSeq++);

          if (step.reasoning) {
            insertPart.run(
              `part_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
              mid, sessionId, ts, ts,
              JSON.stringify({ type: 'reasoning', text: step.reasoning }),
              partSeq++,
            );
          }

          for (const b of step.blocks) {
            if (b.kind === 'text' && b.role === 'assistant') {
              insertPart.run(
                `part_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
                mid, sessionId, ts, ts,
                JSON.stringify({ type: 'text', text: b.text, time: { start: ts, end: ts } }),
                partSeq++,
              );
            } else if (b.kind === 'tool-call') {
              // 找配对的 result
              const result = step.blocks.find(
                (x) => x.kind === 'tool-result' && x.callId === b.callId,
              ) as any;
              insertPart.run(
                `part_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
                mid, sessionId, ts, ts,
                JSON.stringify({
                  type: 'tool',
                  callID: b.callId,
                  tool: b.name,
                  state: {
                    status: result ? (result.isError ? 'error' : 'completed') : 'completed',
                    input: b.args ?? {},
                    ...(result ? { output: result.output.text } : {}),
                    title: b.name,
                  },
                  time: { start: ts, end: ts },
                }),
                partSeq++,
              );
            }
          }
        }
      }

      return {
        ok: true,
        targetId: sessionId,
        location: `${dbFile}#session=${sessionId}`,
        records: msgSeq + partSeq,
        warnings: [`已备份原数据库到 ${backupFile}`],
      };
    } finally {
      db.close();
    }
  }
}

export const zcodeAdapter = new ZcodeAdapter();
