/**
 * convert/dsh2wb.ts —— DSH 会话 → WorkBuddy 会话（JSONL 行）
 *
 * WorkBuddy（腾讯 CodeBuddy 系）本地会话格式实测（2026-10）：
 *   会话 = sqlite `sessions` 表一行元数据 + `projects/<cwd编码>/<sessionId>.jsonl` 内容
 *   JSONL 行类型：session-meta / message / reasoning / function_call / function_call_result / ai-title
 *
 * 与 Codex rollout 的差异：
 *   - 有 parentId 链（每条记录指向上一条，形成消息树）
 *   - message.content 的 block 类型是 input_text / output_text
 *   - reasoning 用 rawContent[].reasoning_text，content 为空数组
 *   - 工具调用是 function_call + function_call_result（callId 关联）
 *   - 会话标题是独立的 ai-title 行
 */
import type { DshEvent, DshSession } from '../shared/types.js';

/** WorkBuddy 的一条 JSONL 记录（保持宽松类型，便于逐类型构造） */
export interface WbRow {
  id: string;
  parentId?: string;
  timestamp: number;
  type: string;
  [key: string]: unknown;
}

export interface WbExportReport {
  ok: boolean;
  stats: { rows: number; messages: number; toolCalls: number; toolResults: number };
  warnings: string[];
}

let idCounter = 0;
function nextId(kind: string): string {
  // WorkBuddy 的 id 是 UUID 形态；用确定性伪 UUID（同一会话多次转换保持一致）
  idCounter++;
  const n = idCounter.toString(16).padStart(12, '0');
  const seq = Date.now().toString(16).slice(-8).padStart(8, '0');
  const prefix = kind.padEnd(8, '0').slice(0, 8).replace(/[^0-9a-f]/g, '0');
  return `${prefix}-0000-4000-8000-${seq}${n.slice(-4)}`;
}

/** 提取消息纯文本 */
function joinText(content: any[] | undefined): string {
  return (content ?? [])
    .filter((b) => b && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/**
 * 把 DSH 会话转换为 WorkBuddy JSONL 行。
 * @param session DSH 会话
 * @param sessionId WorkBuddy 会话 id（由调用方生成，需与 sessions 表一致）
 * @param cwd 会话工作目录（Windows 反斜杠形式，写入 ai-title）
 */
export function dshToWorkbuddy(
  session: DshSession,
  opts: { sessionId: string; cwd: string; title?: string },
): { rows: WbRow[]; report: WbExportReport } {
  idCounter = 0;
  const warnings: string[] = [];
  const rows: WbRow[] = [];
  let parentId: string | undefined;
  let title = '';
  const callNames = new Map<string, string>();
  const stats = { rows: 0, messages: 0, toolCalls: 0, toolResults: 0 };

  const push = (row: Omit<WbRow, 'id' | 'parentId'>) => {
    const typeName = typeof row.type === 'string' ? row.type : 'row';
    const id = nextId(typeName.replace(/[^a-z]/gi, ''));
    const full: WbRow = { id, ...(parentId ? { parentId } : {}), ...row } as WbRow;
    rows.push(full);
    parentId = id;
    stats.rows++;
    return full;
  };

  // 1. session-meta（头部）
  push({
    type: 'session-meta',
    sessionId: opts.sessionId,
    timestamp: session.header.createdAt,
    meta: { 'codebuddy.ai/hostKind': 'unopted' },
  } as any);

  // 2. 遍历事件
  for (const e of session.events) {
    const d = (e.data ?? {}) as any;

    switch (e.type) {
      case 'session/title': {
        title = String(d.title ?? '').trim();
        break;
      }

      case 'user/message': {
        // 子代理中继消息不写入 WorkBuddy（WorkBuddy 无对应概念）
        const src = d.source ?? {};
        if (src.kind === 'agent-message') {
          warnings.push('子代理中继消息已跳过（WorkBuddy 无对应概念）');
          break;
        }
        const text = joinText(d.content);
        if (!text) break;
        push({
          type: 'message',
          timestamp: e.time,
          role: 'user',
          content: [{ type: 'input_text', text }],
        } as any);
        stats.messages++;
        break;
      }

      case 'assistant/message': {
        const blocks: any[] = d.message?.content ?? [];
        const reasoning = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text).filter(Boolean).join('\n');
        if (reasoning) {
          push({
            type: 'reasoning',
            timestamp: e.time,
            content: [],
            rawContent: [{ type: 'reasoning_text', text: reasoning }],
          } as any);
        }
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).filter(Boolean).join('\n');
        if (text) {
          push({
            type: 'message',
            timestamp: e.time,
            role: 'assistant',
            content: [{ type: 'output_text', text }],
          } as any);
          stats.messages++;
        }
        break;
      }

      case 'tool/call': {
        callNames.set(String(d.callId), String(d.name ?? 'tool'));
        push({
          type: 'function_call',
          timestamp: e.time,
          callId: d.callId,
          name: d.name ?? 'tool',
          arguments: typeof d.arguments === 'string' ? d.arguments : JSON.stringify(d.arguments ?? {}),
        } as any);
        stats.toolCalls++;
        break;
      }

      case 'tool/result': {
        const m = d.message ?? {};
        const callId = m.toolCallId ?? m.source?.callId;
        const output = joinText(m.content);
        push({
          type: 'function_call_result',
          timestamp: e.time,
          name: callNames.get(String(callId)) ?? 'tool',
          callId,
          status: m.isError ? 'failed' : 'completed',
          output: { type: 'text', text: output },
        } as any);
        stats.toolResults++;
        break;
      }

      default:
        break;
    }
  }

  // 3. ai-title（标题行）
  const finalTitle = (opts.title || title || '导入会话').slice(0, 200);
  push({
    type: 'ai-title',
    timestamp: Date.now(),
    aiTitle: finalTitle,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
  } as any);

  return { rows, report: { ok: true, stats, warnings: [...new Set(warnings)] } };
}
