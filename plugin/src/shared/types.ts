/**
 * shared/types.ts —— Codex / DSH 双端数据类型定义
 *
 * 所有字段名严格对应实测的真实格式：
 *   - Codex rollout：{timestamp, ordinal, type, payload}
 *   - DSH v4 事件：{type, seq, time, data, surfaceOp?}
 */

// ══════════════════════════════════════════════
// DSH 侧（已由 P0 用真实校验器验证）
// ══════════════════════════════════════════════

/**
 * DSH v4 会话头。
 * ⚠️ 严格白名单：version/id/createdAt/isSeeded/delegationDepth 必填，
 *    仅允许额外出现 cwd / parentSession / origin / agentPreset。
 *    任何未知字段都会导致加载失败（实测 format v4 header has unexpected field）。
 */
export interface DshHeader {
  version: 4;
  id: string;
  createdAt: number;
  isSeeded: boolean;
  delegationDepth: number;
  cwd?: string;
  parentSession?: string;
  origin?: 'subagent';
  agentPreset?: string;
}

/** surfaceOp 合法形态（实测：'append' 字符串，或 replace 对象） */
export type DshSurfaceOp =
  | 'append'
  | { op: 'replace'; startSeq: number; endSeq: number };

export interface DshEvent {
  type: string;
  /** 必须等于事件数组下标（实测：非稠密会被 is not dense 拒绝） */
  seq: number;
  time: number;
  data: Record<string, unknown>;
  surfaceOp?: DshSurfaceOp;
  ignorable?: boolean;
}

export interface DshSession {
  header: DshHeader;
  events: DshEvent[];
}

/** DSH 消息 source.kind 合法值（kind:'plugin' 被硬拒） */
export type DshMessageSource =
  | { kind: 'user'; origin?: string; rpcId?: string; clientTimeZone?: string }
  | { kind: 'model'; provider?: string; model?: string; imported?: boolean; replayState?: unknown }
  | { kind: 'tool'; callId: string }
  | { kind: 'agent-message'; form: 'relay'; senderSessionId: string }
  | { kind: 'team-message'; teamId: string; messageId: string; senderId: string; senderName: string }
  | { kind: string; [k: string]: unknown }; // 其他 producer-owned kind

export interface DshContentBlock {
  type: 'text' | 'reasoning' | 'image' | 'file' | 'tool-call' | string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: string;
  attachment?: unknown;
}

export interface DshMessage {
  role: 'user' | 'assistant' | 'system' | 'developer' | 'tool';
  id: string;
  content: DshContentBlock[];
  source: DshMessageSource;
  toolCallId?: string;
  isError?: boolean;
}

// ══════════════════════════════════════════════
// Codex 侧（实测于真实 rollout）
// ══════════════════════════════════════════════

export interface CodexLine {
  timestamp?: string;
  ordinal?: number;
  type: 'session_meta' | 'turn_context' | 'response_item' | 'event_msg'
  | 'token_usage_record' | 'compacted' | 'world_state' | 'inter_agent_communication_metadata';
  payload: Record<string, any>;
  metadata?: Record<string, unknown>;
}

/** session_meta.payload —— 注意子代理的 session_id 指向父线程 */
export interface CodexSessionMeta {
  id: string;                       // ★ 自身线程 id
  session_id: string;               // ★ 子代理时 = 父线程 id
  parent_thread_id?: string;
  timestamp: string;
  cwd: string;
  runtime_workspace_roots?: string[];
  originator?: string;
  cli_version?: string;
  source?: string | { subagent?: { thread_spawn?: CodexThreadSpawn } };
  thread_source?: 'user' | 'subagent';
  model_provider?: string;
  base_instructions?: { text: string };
  history_mode?: string;
  context_window?: { window_id: string };
  git?: { commit_hash: string; branch: string };
  creator_user_id?: string;
  creator_account_id?: string;
  agent_nickname?: string;
  agent_path?: string;
  multi_agent_version?: string;
}

export interface CodexThreadSpawn {
  parent_thread_id: string;
  depth: number;
  agent_path: string;
  agent_nickname?: string;
  agent_role?: string | null;
}

export interface CodexTurnContext {
  turn_id: string;
  root_turn_id?: string;
  cwd: string;
  workspace_roots?: string[];
  current_date?: string;
  timezone?: string;
  approval_policy?: string;
  sandbox_policy?: { type: string };
  permission_profile?: unknown;
  active_permission_profile?: { id: string };
  model: string;
  personality?: string;
  collaboration_mode?: { mode: string; settings?: Record<string, unknown> };
  multi_agent_version?: string;
  effort?: string;
  summary?: string;
}

/** response_item 的各类 payload */
export type CodexResponseItem =
  | { type: 'message'; id: string; role: 'user' | 'assistant' | 'developer' | 'system'; content: CodexContentPart[] }
  | { type: 'reasoning'; id: string; summary: Array<{ type: string; text: string }>; content?: unknown }
  | { type: 'function_call'; id: string; name: string; arguments: string; call_id: string }
  | { type: 'function_call_output'; id: string; call_id: string; output: string }
  | { type: 'custom_tool_call'; id: string; status: string; call_id: string; name: string; input: string }
  | { type: 'custom_tool_call_output'; id: string; call_id: string; output: CodexContentPart[] }
  | { type: 'agent_message'; id: string; author: string; recipient: string; content: CodexContentPart[] };

export interface CodexContentPart {
  type: string; // input_text | output_text | text | encrypted_content | summary_text
  text?: string;
  encrypted_content?: string;
}

/** item_completed 的 item 类型（用于提取结构化事件） */
export type CodexItem =
  | { type: 'UserMessage'; id: string; content: Array<{ type: string; text: string }> }
  | { type: 'AgentMessage'; id: string; content: Array<{ type: string; text: string }>; phase?: string }
  | { type: 'Reasoning'; id: string }
  | { type: 'CommandExecution'; id: string; command: string[]; cwd?: string; status?: string; aggregated_output?: string }
  | { type: 'FileChange'; id: string; changes: Record<string, { type: 'add' | 'update' | 'delete'; content?: string }> }
  | { type: 'SubAgentActivity'; id: string; kind: 'started' | 'finished'; agent_thread_id: string; agent_path: string }
  | { type: 'McpToolCall'; id: string }
  | { type: 'ImageView'; id: string }
  | { type: 'ContextCompaction'; id: string }
  | { type: 'Extension'; id: string };

export interface CodexSubAgentActivity extends Record<string, unknown> {
  type: 'SubAgentActivity';
  id: string;
  kind: 'started' | 'finished';
  agent_thread_id: string;
  agent_path: string;
}

/** 扫描得到的会话摘要（用于列表展示） */
export interface CodexSessionSummary {
  /** Codex thread id（来自 payload.id） */
  id: string;
  /** rollout 文件绝对路径 */
  filePath: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  sizeBytes: number;
  compressed: boolean;
  isSubagent: boolean;
  parentThreadId?: string;
  agentPath?: string;
  agentNickname?: string;
  turnCount: number;
  messageCount: number;
}

/** 导入结果报告 */
export interface ImportReport {
  sourceId: string;
  sourceFile: string;
  ok: boolean;
  targetSessionId?: string;
  stats: {
    turns: number;
    steps: number;
    messages: number;
    toolCalls: number;
    toolResults: number;
    subagents: number;
    encryptedBlocks: number;
    encryptedBytes: number;
  };
  encryptedDetail: Array<{ ordinal: number; kind: string; author?: string; bytes: number }>;
  warnings: string[];
  error?: { code: string; message: string };
}

/** 导出结果报告 */
export interface ExportReport {
  sourceSessionId: string;
  ok: boolean;
  outFile?: string;
  backupFile?: string;
  stats: { lines: number; messages: number; toolCalls: number; bytes: number };
  warnings: string[];
  error?: { code: string; message: string };
}

/** 操作日志条目 */
export interface OpLogEntry {
  id: string;
  at: number;
  op: 'import' | 'export' | 'backup' | 'scan' | 'error';
  phase: 'start' | 'ok' | 'fail';
  sessionId?: string;
  message: string;
  detail?: Record<string, unknown>;
}
