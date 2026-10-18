/**
 * convert/dsh2codex.ts —— DSH v4 会话 → Codex rollout（OpenAI 兼容 JSONL）
 *
 * 输出格式对齐 Codex 实测结构：
 *   { timestamp, ordinal, type, payload }
 *   type ∈ session_meta / turn_context / response_item / event_msg
 *
 * response_item 与 OpenAI Responses API 的 item 同构：
 *   message / reasoning / function_call / function_call_output
 */
import type {
  DshEvent, DshSession, CodexLine, ExportReport,
} from '../shared/types.js';
import { reverseToolName, reverseArguments } from './toolmap.js';

/**
 * 兜底 system prompt：Codex 的 session_meta.base_instructions 是加载会话的必需字段。
 * 导出时若无法从来源恢复原始 prompt，用这段通用说明（真实 Codex 会话约 21k 字符，
 * 这里给精简版以便 Codex 能正常打开并续聊）。
 */
const DEFAULT_BASE_INSTRUCTIONS = [
  'You are Codex, a coding agent. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.',
  '',
  '# Personality',
  'You are a deeply pragmatic, effective software engineer. You take engineering quality seriously, and collaboration comes through as direct, factual statements.',
  '',
  '## Values',
  '- Clarity: communicate reasoning explicitly and concretely, so decisions and tradeoffs are easy to evaluate.',
  '- Pragmatism: keep the end goal and momentum in mind, focusing on what will actually work.',
  '- Rigor: expect technical arguments to be coherent and defensible; surface gaps and weak assumptions politely.',
  '',
  '## Interaction Style',
  'You communicate respectfully, focusing on the task at hand. You always prioritize actionable guidance and state assumptions clearly.',
  '',
  '# Note',
  'This conversation was exported from DeepSeek Harness. Historical tool results may no longer match the current workspace; re-run or verify before relying on them.',
].join('\n');

function iso(t: number): string {
  return new Date(t).toISOString();
}

/** 提取 DSH 消息中的纯文本 */
function joinText(content: any[] | undefined): string {
  return (content ?? [])
    .filter((b) => b && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** 生成 Codex 风格的 UUID（用于 context_window.window_id 等） */
function uuidLike(): string {
  return crypto.randomUUID();
}

/** 安全解析 JSON 字符串为对象 */
function safeParse(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** 导出主函数 */
export function dshToCodex(
  session: DshSession,
  opts: { toolName?: string; baseInstructions?: string } = {},
): { jsonl: string; report: ExportReport } {
  const { header, events } = session;
  const warnings: string[] = [];
  const lines: CodexLine[] = [];
  let ordinal = 0;

  const emit = (type: CodexLine['type'], payload: Record<string, unknown>, ts: number) => {
    lines.push({ timestamp: iso(ts), ordinal: ordinal++, type, payload });
  };

  // ── 1. 从导入元数据还原 Codex 原有身份（保证往返可逆）──
  //    优先读专用事件 codex-bridge/meta，兼容旧版 model/selection.xCodexMeta
  const metaEvt = events.find((e) => e.type === 'codex-bridge/meta');
  const legacyEvt = events.find((e) => e.type === 'model/selection' && (e.data as any)?.xCodexMeta);
  const xMeta: any = (metaEvt?.data as any)
    ?? ((legacyEvt?.data as any)?.xCodexMeta)
    ?? {};
  const threadId = xMeta.sessionId ?? deriveThreadId(header.id);

  // session_meta
  // ★ base_instructions 是 Codex 加载会话必需的 system prompt。
  //   优先用导入时附着的原始值；否则由调用方提供模板；再否则用通用兜底。
  const baseInstructions = xMeta.baseInstructions
    ?? (opts.baseInstructions ? { text: opts.baseInstructions } : { text: DEFAULT_BASE_INSTRUCTIONS });

  emit('session_meta', {
    id: threadId,
    session_id: xMeta.parentThreadId ? xMeta.parentThreadId : threadId,
    ...(xMeta.parentThreadId ? { parent_thread_id: xMeta.parentThreadId } : {}),
    timestamp: iso(header.createdAt),
    cwd: header.cwd ?? process.cwd(),
    runtime_workspace_roots: xMeta.workspaceRoots ?? (header.cwd ? [header.cwd] : []),
    originator: xMeta.originator ?? 'DeepSeek Harness',
    cli_version: xMeta.cliVersion ?? 'dsh-export',
    source: xMeta.source ?? 'dsh',
    thread_source: xMeta.threadSource ?? (header.origin === 'subagent' ? 'subagent' : 'user'),
    model_provider: xMeta.modelProvider ?? 'openai',
    base_instructions: baseInstructions,
    history_mode: xMeta.historyMode ?? 'paginated',
    // 自包含完整会话：不指向任何外部历史（真实的 paginated 会话这里会指向父会话的偏移）
    history_base: null,
    multi_agent_version: 'v2',
    context_window: { window_id: xMeta.contextWindow?.window_id ?? uuidLike() },
    ...(xMeta.git ? { git: xMeta.git } : {}),
    ...(xMeta.creator ? {
      creator_user_id: xMeta.creator.userId,
      creator_account_id: xMeta.creator.accountId,
    } : {}),
  }, header.createdAt);

  // ── 2. 定位压缩分界：被 shadowed 的事件不进导出 ──
  const shadowed = new Set<number>();
  for (const e of events) {
    if (e.type === 'compaction/prune') {
      const seqs = (e.data as any)?.shadowedSeqs;
      if (Array.isArray(seqs)) seqs.forEach((s: number) => shadowed.add(s));
      const range = (e.data as any)?.shadowedRange;
      if (range && Number.isInteger(range.start) && Number.isInteger(range.end)) {
        for (let s = range.start; s <= range.end; s++) shadowed.add(s);
      }
    }
  }

  let statMessages = 0;
  let statToolCalls = 0;
  let currentTurnId = '';
  let turnStarted = false;
  /** 当前 turn 的起始时间（用于 task_complete 的 started_at / duration_ms） */
  let turnStartMs = 0;
  /** 当前 turn 的最后一条 assistant 正文（用于 task_complete 的 last_agent_message） */
  let lastAgentMessage = '';
  /** 工具调用信息缓存（tool/call 先到，tool/result 到达时补全 CommandExecution） */
  const pendingCalls = new Map<string, { name: string; args: string; time: number }>();

  /**
   * ★ 生成 Codex UI 渲染所需的 item_completed 事件。
   * 实测：Codex Desktop 的消息渲染读 thread_history 投影，而投影源数据是
   * rollout 里的 `event_msg/item_completed`。缺这类事件 → UI 报 "Couldn't load messages"。
   */
  const emitItem = (item: Record<string, unknown>, startedMs: number, completedMs: number, time: number) => {
    emit('event_msg', {
      type: 'item_completed',
      thread_id: threadId,
      turn_id: currentTurnId || 'turn-1',
      item,
      started_at_ms: startedMs,
      completed_at_ms: completedMs,
    }, time);
  };

  const startTurn = (e: DshEvent) => {
    const turnNo = (e.data as any)?.turn ?? 1;
    currentTurnId = `turn-${turnNo}`;
    turnStartMs = e.time;
    if (!turnStarted) {
      turnStarted = true;
      emit('event_msg', {
        type: 'task_started',
        turn_attribution: {
          turn_id: currentTurnId,
          turn_trigger: 'composer',
          parent_turn_id: null,
          initiating_agent_path: null,
          root_turn_id: currentTurnId,
        },
        turn_id: currentTurnId,
        root_turn_id: currentTurnId,
        started_at: Math.floor(e.time / 1000),
        model_context_window: 0,
        collaboration_mode_kind: 'default',
      }, e.time);
    }
  };

  for (const e of events) {
    if (shadowed.has(e.seq)) continue;

    switch (e.type) {
      case 'turn/start': {
        startTurn(e);
        const model = effectiveModelFrom(events);
        emit('turn_context', {
          turn_id: currentTurnId,
          root_turn_id: currentTurnId,
          disabled_plugin_ids: [],
          cwd: header.cwd ?? process.cwd(),
          workspace_roots: header.cwd ? [header.cwd] : [],
          current_date: new Date(e.time).toISOString().slice(0, 10),
          timezone: 'UTC',
          approval_policy: 'never',
          approvals_reviewer: 'user',
          sandbox_policy: { type: 'danger-full-access' },
          permission_profile: { type: 'disabled' },
          active_permission_profile: { id: ':danger-full-access' },
          model,
          personality: 'pragmatic',
          collaboration_mode: { mode: 'default', settings: { model } },
          multi_agent_version: 'v2',
          realtime_active: false,
          effort: 'medium',
          summary: 'auto',
        }, e.time);
        break;
      }

      case 'turn/end': {
        const durMs = Math.max(0, e.time - (turnStartMs || e.time));
        emit('event_msg', {
          type: 'task_complete',
          root_turn_id: currentTurnId,
          turn_id: currentTurnId,
          last_agent_message: lastAgentMessage,
          started_at: Math.floor((turnStartMs || e.time) / 1000),
          completed_at: Math.floor(e.time / 1000),
          duration_ms: durMs,
          time_to_first_token_ms: 0,
        }, e.time);
        turnStarted = false;
        lastAgentMessage = '';
        break;
      }

      case 'user/message': {
        const d = e.data as any;
        const src = d.source ?? {};
        const userText = (d.content ?? [])
          .filter((b: any) => typeof b?.text === 'string')
          .map((b: any) => b.text).join('\n');
        // 子代理中继消息 → 还原为 Codex agent_message
        if (src.kind === 'agent-message') {
          const sender = String(src.senderSessionId ?? 'unknown');
          emit('response_item', {
            type: 'agent_message',
            id: `amsg_${e.seq}`,
            author: `/${sender}`,
            recipient: '/root',
            content: (d.content ?? []).map((b: any) => ({
              type: b.type === 'text' ? 'input_text' : b.type,
              ...(b.text !== undefined ? { text: b.text } : {}),
            })),
          }, e.time);
          // UI 渲染：AgentMessage
          emitItem({
            type: 'AgentMessage',
            id: `amsg_${e.seq}`,
            content: [{ type: 'Text', text: userText }],
          }, e.time, e.time, e.time);
        } else {
          emit('response_item', {
            type: 'message',
            id: d.id ?? `msg_${e.seq}`,
            role: 'user',
            content: (d.content ?? []).map((b: any) => ({
              type: 'input_text',
              text: b.text ?? '',
            })),
          }, e.time);
          // UI 渲染：UserMessage
          emitItem({
            type: 'UserMessage',
            id: d.id ?? `item-${e.seq}`,
            content: [{ type: 'text', text: userText, text_elements: [] }],
          }, e.time, e.time, e.time);
        }
        statMessages++;
        break;
      }

      case 'assistant/message': {
        const m = (e.data as any)?.message ?? {};
        const blocks: any[] = m.content ?? [];

        // 推理摘要
        const reasoning = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text).join('\n');
        if (reasoning) {
          emit('response_item', {
            type: 'reasoning',
            id: `rs_${e.seq}`,
            summary: [{ type: 'summary_text', text: reasoning }],
          }, e.time);
          // UI 渲染：Reasoning（summary_text 是字符串数组）
          emitItem({
            type: 'Reasoning',
            id: `rs_${e.seq}`,
            summary_text: [reasoning],
          }, e.time, e.time, e.time);
        }

        // 正文
        const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        if (texts) {
          // 记录为本 turn 的最后一条 assistant 正文（task_complete 的 last_agent_message）
          lastAgentMessage = texts.slice(0, 2000);
          emit('response_item', {
            type: 'message',
            id: m.id ?? `msg_${e.seq}`,
            role: 'assistant',
            content: [{ type: 'output_text', text: texts }],
          }, e.time);
          // UI 渲染：AgentMessage（content type 是大写 Text）
          emitItem({
            type: 'AgentMessage',
            id: m.id ?? `msg_${e.seq}`,
            content: [{ type: 'Text', text: texts }],
          }, e.time, e.time, e.time);
          statMessages++;
        }
        break;
      }

      case 'tool/call': {
        const d = e.data as any;
        const codexName = reverseToolName(d.name);
        const args = reverseArguments(d.name, d.arguments ?? '{}');
        emit('response_item', {
          type: 'function_call',
          id: `fc_${d.callId}`,
          call_id: d.callId,
          name: codexName,
          arguments: args,
        }, e.time);
        // 缓存，等 tool/result 到达时生成完整的 CommandExecution
        pendingCalls.set(d.callId, { name: d.name, args: d.arguments ?? '{}', time: e.time });
        statToolCalls++;
        break;
      }

      case 'tool/result': {
        const m = (e.data as any)?.message ?? {};
        const callId = m.toolCallId ?? m.source?.callId ?? `call_${e.seq}`;
        const output = joinText(m.content);
        const isError = m.isError === true;
        emit('response_item', {
          type: 'function_call_output',
          id: `fco_${callId}`,
          call_id: callId,
          output,
        }, e.time);

        // UI 渲染：CommandExecution（Codex 用它渲染工具调用与输出）
        const call = pendingCalls.get(callId);
        const callArgs = call ? safeParse(call.args) : {};
        const cmdText = String((callArgs as any)?.command ?? (callArgs as any)?.cmd
          ?? call?.name ?? 'tool');
        const toolName = call?.name ?? 'tool';
        emitItem({
          type: 'CommandExecution',
          id: callId,
          process_id: '0',
          command: ['pwsh', '-Command', cmdText],
          cwd: 'file:///' + (header.cwd ?? process.cwd()).replace(/\\/g, '/'),
          parsed_cmd: [{ type: 'unknown', cmd: cmdText }],
          source: 'unified_exec_startup',
          status: isError ? 'failed' : 'completed',
          aggregated_output: output,
          exit_code: isError ? 1 : 0,
          duration: { secs: 0, nanos: 0 },
        }, call?.time ?? e.time, e.time, e.time);
        pendingCalls.delete(callId);
        break;
      }

      case 'session/title': {
        emit('event_msg', {
          type: 'thread_name_updated',
          thread_name: String((e.data as any)?.title ?? ''),
        }, e.time);
        break;
      }

      case 'subagent/catalog': {
        const d = e.data as any;
        emit('event_msg', {
          type: 'item_completed',
          item: {
            type: 'SubAgentActivity',
            id: `sa_${e.seq}`,
            kind: 'started',
            agent_thread_id: d.childId,
            agent_path: d.label ?? '',
          },
        }, e.time);
        break;
      }

      default:
        break;
    }
  }

  const jsonl = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

  const report: ExportReport = {
    sourceSessionId: header.id,
    ok: true,
    stats: {
      lines: lines.length,
      messages: statMessages,
      toolCalls: statToolCalls,
      bytes: Buffer.byteLength(jsonl, 'utf8'),
    },
    warnings,
  };

  return { jsonl, report };
}

/** 从会话中提取模型名 */
function effectiveModelFrom(events: DshEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'model/selection') {
      const m = (events[i].data as any)?.model;
      if (typeof m === 'string' && m) return m;
    }
  }
  return 'gpt-5';
}

/** DSH 会话 id → Codex thread id */
function deriveThreadId(dshId: string): string {
  const m = dshId.match(/^session-codex-(.+)$/);
  if (m) return m[1];
  // DSH 的 session-<uuid> → 直接去前缀
  return dshId.replace(/^session-/, '');
}
