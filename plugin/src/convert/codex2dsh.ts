/**
 * convert/codex2dsh.ts —— Codex rollout → DSH v4 会话
 *
 * ⚠️ 本文件的每一条规则都来自 P0 实测验证（见 P0-VALIDATION-REPORT.md）：
 *
 *  1. seq 必须从 0 稠密递增（跳号 → "is not dense"）
 *  2. 会话头严格白名单：version/id/createdAt/isSeeded/delegationDepth
 *     + 仅 cwd/parentSession/origin/agentPreset；任何自定义字段 → 加载失败
 *  3. turn/start → step/start → 消息 → step/end → turn/end 必须闭合
 *  4. source.kind 必须非空且 ≠ 'plugin'
 *  5. tool/result 需 message.id + toolCallId === source.callId
 *  6. surfaceOp 只能是 'append' 或 {op:'replace',startSeq,endSeq}
 *
 * 元数据策略（因会话头不接受自定义字段）：
 *   把 Codex 独有字段写进 model/selection 事件的 data.xCodexMeta（事件级不校验未知字段）。
 *
 * 重组策略：
 *   一个 step = Codex 中一次 assistant 输出 + 其后的工具结果。
 *   同一 step 内按原始顺序保留多段 assistant（不合并），避免消息数量塌缩。
 */
import type {
  CodexLine, CodexSessionMeta, CodexResponseItem, CodexItem,
  DshEvent, DshHeader, DshSession, DshContentBlock, ImportReport,
} from '../shared/types.js';
import { mapFunctionCall, mapCustomToolCall } from '../convert/toolmap.js';

const ENCRYPTED_PLACEHOLDER = (bytes: number) => `[加密内容 · 无法解码 · ${bytes} 字节]`;

interface EncryptedAcc {
  blocks: number;
  bytes: number;
  detail: Array<{ ordinal: number; kind: string; author?: string; bytes: number }>;
}

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq.toString(16).padStart(6, '0')}`;
}

/** 内容块规范化：加密块换为合法 text 占位，保持数组同形 */
function normalizeContent(
  parts: Array<{ type?: string; text?: string; encrypted_content?: string }> | undefined,
  acc: EncryptedAcc,
  ordinal: number,
  kind: string,
  author?: string,
): DshContentBlock[] {
  const out: DshContentBlock[] = [];
  for (const p of parts ?? []) {
    if (!p) continue;
    if (p.type === 'encrypted_content') {
      const bytes = Buffer.byteLength(p.encrypted_content ?? '', 'utf8');
      acc.blocks++;
      acc.bytes += bytes;
      acc.detail.push({ ordinal, kind, author, bytes });
      out.push({ type: 'text', text: ENCRYPTED_PLACEHOLDER(bytes) });
    } else if (typeof p.text === 'string') {
      out.push({ type: 'text', text: p.text });
    }
  }
  return out;
}

function reasoningText(payload: any): string {
  const parts = Array.isArray(payload?.summary) ? payload.summary : [];
  return parts.map((s: any) => (typeof s?.text === 'string' ? s.text : '')).filter(Boolean).join('\n');
}

function normalizeToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
  }
  if (output == null) return '';
  return String(output);
}

function detectError(output: string): boolean {
  const m = output.match(/Process exited with code (\d+)/);
  if (m) return Number(m[1]) !== 0;
  return /^Error[: ]/i.test(output.trim());
}

// ───────── 重组模型 ─────────

interface CallInfo { callId: string; name: string; arguments: string; degraded: boolean; note?: string }

/** 一段 assistant 输出（对应一条 Codex assistant message 及其挂载的 tool-call） */
interface AssistantPiece {
  kind: 'assistant';
  reasoning: string;
  texts: string[];
  toolCalls: CallInfo[];
}

interface ToolResultPiece {
  kind: 'toolResult';
  callId: string;
  text: string;
  isError: boolean;
  toolName: string;
}

type Piece = AssistantPiece | ToolResultPiece;

interface Unit {
  userMessages: Array<{ id: string; content: DshContentBlock[]; source: any }>;
  agentMessages: Array<{ id: string; content: DshContentBlock[]; author: string }>;
  pieces: Piece[];
}

interface Turn { turnId: string; units: Unit[] }

export function codexToDsh(
  lines: CodexLine[],
  opts: { sourceFile: string; includeSubagentsAsCatalog?: boolean; title?: string },
): { session: DshSession; report: ImportReport } {
  idSeq = 0;
  const meta = lines.find((l) => l.type === 'session_meta')?.payload as CodexSessionMeta | undefined;
  if (!meta) {
    return {
      session: { header: emptyHeader(), events: [] },
      report: {
        sourceId: '', sourceFile: opts.sourceFile, ok: false,
        stats: zeroStats(), encryptedDetail: [], warnings: [],
        error: { code: 'NO_SESSION_META', message: '缺少 session_meta' },
      },
    };
  }

  const acc: EncryptedAcc = { blocks: 0, bytes: 0, detail: [] };
  const warnings: string[] = [];

  // ── compacted 分界 ──
  let compactedIndex = -1;
  const compactedReplacement: Array<{ role: string; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== 'compacted') continue;
    compactedIndex = i;
    const hist = (lines[i].payload as any)?.replacement_history;
    if (Array.isArray(hist)) {
      for (const m of hist) {
        const text = (m?.content ?? [])
          .map((c: any) => (typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
        if (text) compactedReplacement.push({ role: m.role ?? 'user', text });
      }
    }
  }
  const effective = compactedIndex >= 0
    ? lines.slice(compactedIndex + 1).filter((l) => l.type !== 'compacted')
    : lines;

  // ── 重组 ──
  const turns: Turn[] = [];
  const turnMap = new Map<string, Turn>();
  let currentUnit: Unit | null = null;
  let activeTurnId = '';
  const callMeta = new Map<string, CallInfo>();

  const ensureTurn = (turnId: string): Turn => {
    let t = turnMap.get(turnId);
    if (!t) { t = { turnId, units: [] }; turnMap.set(turnId, t); turns.push(t); }
    return t;
  };
  const ensureUnit = (t: Turn): Unit => {
    if (!currentUnit) { currentUnit = { userMessages: [], agentMessages: [], pieces: [] }; t.units.push(currentUnit); }
    return currentUnit;
  };
  /** 取当前 unit 里最后一段 assistant；没有就新建一段 */
  const currentAssistant = (u: Unit): AssistantPiece => {
    const last = u.pieces[u.pieces.length - 1];
    if (last && last.kind === 'assistant') return last;
    const p: AssistantPiece = { kind: 'assistant', reasoning: '', texts: [], toolCalls: [] };
    u.pieces.push(p);
    return p;
  };

  for (let idx = 0; idx < effective.length; idx++) {
    const line = effective[idx];
    const ordinal = line.ordinal ?? idx;

    if (line.type === 'turn_context' || (line.type === 'event_msg' && (line.payload as any)?.type === 'task_started')) {
      const id = String((line.payload as any)?.turn_id ?? `turn-${turns.length + 1}`);
      activeTurnId = id;
      ensureTurn(id);
      currentUnit = null;   // 新 turn → 新 step
      continue;
    }

    if (line.type !== 'response_item') continue;
    const item = line.payload as CodexResponseItem;
    const turn = ensureTurn(activeTurnId || 'turn-1');

    switch (item.type) {
      case 'message': {
        if (item.role === 'user') {
          const content = normalizeContent(item.content, acc, ordinal, 'user message');
          const hasRealText = content.some((c) => c.text && !isInjectedContext(c.text));
          if (hasRealText) {
            const u = ensureUnit(turn);
            u.userMessages.push({ id: nextId('u'), content, source: { kind: 'user', origin: 'codex-import' } });
          }
        } else if (item.role === 'assistant') {
          const u = ensureUnit(turn);
          const a = currentAssistant(u);
          for (const c of item.content ?? []) {
            if (typeof c.text === 'string') a.texts.push(c.text);
            else if (c.type === 'encrypted_content') {
              const bytes = Buffer.byteLength(c.encrypted_content ?? '', 'utf8');
              acc.blocks++; acc.bytes += bytes;
              acc.detail.push({ ordinal, kind: 'assistant message', bytes });
              a.texts.push(ENCRYPTED_PLACEHOLDER(bytes));
            }
          }
        }
        // developer / system 消息默认丢弃（Codex 的权限说明，DSH 自行生成）
        break;
      }

      case 'reasoning': {
        const u = ensureUnit(turn);
        const a = currentAssistant(u);
        const t = reasoningText(item);
        if (t) a.reasoning += (a.reasoning ? '\n' : '') + t;
        break;
      }

      case 'function_call':
      case 'custom_tool_call': {
        const m = item.type === 'function_call'
          ? mapFunctionCall(item.name, item.arguments)
          : mapCustomToolCall(item.name, (item as any).input ?? '');
        const callId = (item as any).call_id;
        const info: CallInfo = { callId, name: m.name, arguments: m.arguments, degraded: m.degraded, note: m.note };
        callMeta.set(callId, info);
        const u = ensureUnit(turn);
        const a = currentAssistant(u);
        a.toolCalls.push(info);
        break;
      }

      case 'function_call_output':
      case 'custom_tool_call_output': {
        const u = ensureUnit(turn);
        const text = normalizeToolOutput((item as any).output);
        const callId = (item as any).call_id;
        const cm = callMeta.get(callId);
        u.pieces.push({
          kind: 'toolResult',
          callId,
          text,
          isError: detectError(text),
          toolName: cm?.name ?? 'unknown',
        });
        break;
      }

      case 'agent_message': {
        const u = ensureUnit(turn);
        const content = normalizeContent(item.content, acc, ordinal, 'agent message', item.author);
        u.agentMessages.push({ id: nextId('am'), content, author: item.author });
        break;
      }
      default: break;
    }
  }

  // ── 子代理目录 ──
  const subagents: Array<{ childId: string; startedAt: number; agentPath: string }> = [];
  if (opts.includeSubagentsAsCatalog !== false) {
    const seen = new Set<string>();
    for (const l of lines) {
      if (l.type !== 'event_msg') continue;
      const p = l.payload as any;
      if (p?.type !== 'item_completed') continue;
      const it = p.item as CodexItem | undefined;
      if (it?.type !== 'SubAgentActivity' || (it as any).kind !== 'started') continue;
      const childId = String((it as any).agent_thread_id ?? '');
      if (!childId || seen.has(childId)) continue;
      seen.add(childId);
      subagents.push({
        childId,
        startedAt: Date.parse(l.timestamp ?? '') || Date.now(),
        agentPath: String((it as any).agent_path ?? ''),
      });
    }
  }

  // ── 生成会话头 ──
  // 子代理会话（thread_source='subagent'）需要 parentSession + origin + delegationDepth，
  // 这三个字段是 P0 实测确认的 header 合法字段。
  const spawn = typeof meta.source === 'object' && meta.source !== null
    ? (meta.source as any)?.subagent?.thread_spawn : undefined;
  const isSubagent = meta.thread_source === 'subagent';
  const parentThreadId = meta.parent_thread_id ?? spawn?.parent_thread_id;
  const depth = Number(spawn?.depth ?? (isSubagent ? 1 : 0)) || 0;

  const header: DshHeader = {
    version: 4,
    id: `session-codex-${meta.id}`,
    createdAt: Date.parse(meta.timestamp ?? '') || Date.now(),
    isSeeded: false,
    delegationDepth: isSubagent ? Math.max(depth, 1) : 0,
    ...(meta.cwd ? { cwd: meta.cwd } : {}),
    ...(isSubagent && parentThreadId
      ? { parentSession: `session-codex-${parentThreadId}`, origin: 'subagent' as const }
      : {}),
    agentPreset: 'standard',
  };

  const events: DshEvent[] = [];
  let seq = 0;
  const push = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    events.push({ type, seq: seq++, time: header.createdAt + seq * 10, data, ...extra } as DshEvent);
  };

  let statTurns = 0, statSteps = 0, statMessages = 0, statToolCalls = 0, statToolResults = 0;
  const model = effectiveModel(effective);

  const relevantTurns = turns.filter((t) => t.units.length > 0);

  // 压缩摘要
  if (compactedReplacement.length > 0) {
    push('turn/start', { turn: 1 });
    push('step/start', { turn: 1, step: 1 });
    push('user/message', {
      role: 'user', id: nextId('u'),
      content: [{ type: 'text', text: `【上下文压缩摘要（来自 Codex）】\n\n${compactedReplacement.map((m) => m.text).join('\n\n')}` }],
      source: { kind: 'user', origin: 'codex-compaction' },
    }, { surfaceOp: 'append' });
    push('step/end', { turn: 1, step: 1 });
    push('turn/end', { turn: 1, reason: { kind: 'completed' } });
    statTurns++; statSteps++; statMessages++;
  }

  const base = statTurns;
  for (let ti = 0; ti < relevantTurns.length; ti++) {
    const turnNo = base + ti + 1;
    statTurns++;
    push('turn/start', { turn: turnNo });

    for (let ui = 0; ui < relevantTurns[ti].units.length; ui++) {
      const unit = relevantTurns[ti].units[ui];
      const stepNo = ui + 1;
      statSteps++;
      push('step/start', { turn: turnNo, step: stepNo });

      for (const um of unit.userMessages) {
        push('user/message', { role: 'user', id: um.id, content: um.content, source: um.source }, { surfaceOp: 'append' });
        statMessages++;
      }

      for (const am of unit.agentMessages) {
        const short = String(am.author.split('/').pop() ?? am.author);
        push('user/message', {
          role: 'user', id: am.id,
          content: [{ type: 'text', text: `Agent ${short} sent a message: ` }, ...am.content],
          source: { kind: 'agent-message', form: 'relay', senderSessionId: `codex-agent-${slug(short)}` },
        }, { surfaceOp: 'append' });
        statMessages++;
      }

      // 按原始顺序输出 assistant / tool-result 片段
      for (const piece of unit.pieces) {
        if (piece.kind === 'assistant') {
          const content: DshContentBlock[] = [];
          if (piece.reasoning) content.push({ type: 'reasoning', text: piece.reasoning });
          for (const t of piece.texts) content.push({ type: 'text', text: t });
          for (const tc of piece.toolCalls) {
            content.push({ type: 'tool-call', id: tc.callId, name: tc.name, arguments: tc.arguments });
          }
          if (content.length === 0) continue;

          push('assistant/message', {
            turn: turnNo, step: stepNo,
            message: {
              role: 'assistant', id: nextId('a'), content,
              // ★ 不伪造 replayState（跨端 signature 不可复用）
              source: { kind: 'model', provider: 'codex-import', model, imported: true },
            },
            // ★ 必须提供 stream 数组（DSH 校验 data.stream 必须是数组，否则历史加载报
            //   "invalid settlement fields"）。导入的静态历史无流式块，用空数组即可。
            stream: [],
          }, { surfaceOp: 'append' });
          statMessages++;

          for (const tc of piece.toolCalls) {
            push('tool/call', { turn: turnNo, step: stepNo, callId: tc.callId, name: tc.name, arguments: tc.arguments });
            statToolCalls++;
            if (tc.degraded) {
              warnings.push(`工具「${tc.name}」为语义降级调用${tc.note ? `：${tc.note}` : ''}，该历史结果不可重放`);
            }
          }
        } else {
          push('tool/result', {
            turn: turnNo, step: stepNo,
            message: {
              role: 'tool', id: nextId('tr'),
              toolCallId: piece.callId,
              source: { kind: 'tool', callId: piece.callId },
              content: [{ type: 'text', text: piece.text }],
              isError: piece.isError,
            },
            meta: { importedFrom: 'codex', toolName: piece.toolName },
          }, { surfaceOp: 'append' });
          statToolResults++;
        }
      }

      push('step/end', { turn: turnNo, step: stepNo });
    }

    push('turn/end', { turn: turnNo, reason: { kind: 'completed' } });
  }

  // ★ 会话标题：DSH 的标题来自 session/title 事件（foldSessionTitle 读最后一个）。
  // 缺这个事件 → UI 显示「未命名」。
  // ⚠️ 校验规则（v3→v4 原文）：
  //     messageSeqs.length === 0 !== (source.kind === 'user') 会抛错
  //   即：user 来源 → messageSeqs 必须空；非 user 来源 → 必须非空。
  //   这里用 kind:'user' + 空数组，表示「导入时固定标题」（也不会被自动重命名覆盖）。
  const title = (opts.title?.trim())
    || firstRealUserText(relevantTurns)
    || 'Codex 导入会话';
  push('session/title', {
    title: title.slice(0, 200),
    messageSeqs: [],
    source: { kind: 'user' },
  });

  // 子代理目录
  for (const sa of subagents) {
    push('subagent/catalog', {
      version: 0,
      childId: sa.childId,
      childCreatedAt: sa.startedAt,
      mode: 'one-shot',        // 未导入子会话，必须 one-shot
      label: `${sa.agentPath}`.slice(0, 120),
    });
  }

  // 模型选择
  push('model/selection', { provider: 'codex-import', model });

  // ★ 元数据：使用 ignorable:true 的专用事件（P1 实测通过）
  //   比塞进 model/selection 更干净：语义独立、未识别时可安全忽略。
  //   ⚠️ 必须剔除 undefined 字段（DSH 要求事件无损 JSON 序列化，undefined 会被拒）。
  events.push({
    type: 'codex-bridge/meta',
    seq: seq++,
    time: header.createdAt,
    ignorable: true,          // 必需：没有它会因 "unknown event type" 被拒
    data: stripUndefined({
      sessionId: meta.id,
      parentThreadId: meta.parent_thread_id,
      threadSource: meta.thread_source,
      originator: meta.originator,
      cliVersion: meta.cli_version,
      source: typeof meta.source === 'string' ? meta.source : 'subagent',
      modelProvider: meta.model_provider,
      workspaceRoots: meta.runtime_workspace_roots,
      git: meta.git,
      creator: (meta.creator_user_id || meta.creator_account_id)
        ? stripUndefined({ userId: meta.creator_user_id, accountId: meta.creator_account_id })
        : undefined,
      contextWindow: meta.context_window,
      historyMode: meta.history_mode,
      baseInstructionsLength: meta.base_instructions?.text?.length,
      agentPath: meta.agent_path,
      agentNickname: meta.agent_nickname,
      sourceFile: opts.sourceFile,
      importedAt: Date.now(),
      droppedFields: collectDroppedFields(lines),
    }),
  } as DshEvent);

  // 可靠性提醒
  push('user/message', {
    role: 'user', id: nextId('notice'),
    content: [{
      type: 'text',
      text: [
        '【导入说明】本会话由 Codex 导入。',
        '历史中的文件修改类工具结果（apply_patch / 写文件命令）可能已与当前磁盘不一致，',
        '路径、工作目录、环境变量也可能发生变化。',
        '在依赖这些历史结果继续操作之前，请重新执行或核对相关文件与命令输出。',
        acc.blocks > 0 ? `本会话另有 ${acc.blocks} 处加密内容无法解码，已以占位符呈现。` : '',
      ].filter(Boolean).join(''),
    }],
    source: { kind: 'user', origin: 'codex-import-notice' },
  }, { surfaceOp: 'append' });

  return {
    session: { header, events },
    report: {
      sourceId: meta.id,
      sourceFile: opts.sourceFile,
      ok: true,
      targetSessionId: header.id,
      stats: {
        turns: statTurns, steps: statSteps, messages: statMessages,
        toolCalls: statToolCalls, toolResults: statToolResults,
        subagents: subagents.length,
        encryptedBlocks: acc.blocks, encryptedBytes: acc.bytes,
      },
      encryptedDetail: acc.detail,
      warnings: [...new Set(warnings)],
    },
  };
}

// ───────── 辅助 ─────────

function emptyHeader(): DshHeader {
  return { version: 4, id: 'session-empty', createdAt: Date.now(), isSeeded: false, delegationDepth: 0 };
}

function zeroStats() {
  return {
    turns: 0, steps: 0, messages: 0, toolCalls: 0, toolResults: 0,
    subagents: 0, encryptedBlocks: 0, encryptedBytes: 0,
  };
}

function isInjectedContext(text: string): boolean {
  return /^# AGENTS\.md instructions/.test(text) || /^<environment_context>/.test(text);
}

/** 递归剔除对象里的 undefined 值（DSH 要求事件无损 JSON 序列化） */
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefined(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** 提取第一条真实的用户文本（用于缺 title 时兜底） */
function firstRealUserText(turns: Turn[]): string {
  for (const t of turns) {
    for (const u of t.units) {
      for (const um of u.userMessages) {
        for (const b of um.content) {
          if (b.type === 'text' && b.text && !isInjectedContext(b.text)) {
            const clean = b.text.replace(/\s+/g, ' ').trim();
            if (clean) return clean;
          }
        }
      }
    }
  }
  return '';
}

function effectiveModel(lines: CodexLine[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].type === 'turn_context') {
      const m = (lines[i].payload as any)?.model;
      if (typeof m === 'string' && m) return m;
    }
  }
  return 'unknown';
}

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

function collectDroppedFields(lines: CodexLine[]): string[] {
  const dropped: string[] = [];
  const types = new Set(lines.map((l) => l.type));
  if (types.has('world_state')) dropped.push('world_state（环境快照，DSH 自行生成）');
  if (types.has('token_usage_record')) dropped.push('token_usage_record（逐请求用量，不进入会话历史）');
  if (types.has('event_msg')) dropped.push('event_msg/item_completed（UI 事件流，已提取关键信息）');
  return dropped;
}
