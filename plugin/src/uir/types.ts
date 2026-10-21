/**
 * uir/types.ts —— 统一会话中间表示（UIR）
 *
 * 设计目标：一次建模，五端复用。任意两端互转走 `read(A) → UIR → write(B)`，
 * 避免 N×N 个转换器。
 *
 * 设计原则：
 *   1. 保真优先 —— `opaque` 通道存客户端独有记录，回写时原样还原
 *   2. 顺序保真 —— `blocks` 数组保留原始交错顺序（text/reasoning/tool-call 的先后是语义）
 *   3. 不丢技术细节 —— 工具参数与输出保持原始字符串/结构，不做改写
 *   4. 可裁剪 —— 每个块带价值等级，供 Token 预算器决定裁剪优先级
 */

export type ClientKind = 'dsh' | 'codex' | 'zcode' | 'claude-code' | 'workbuddy' | 'mcp';

/** 信息价值等级（Token 预算器据此裁剪） */
export type ValueTier =
  | 'critical'   // P0 永不删：代码块、命令、路径、参数、错误、版本号
  | 'high'       // P1：工具调用、决策理由、约束
  | 'medium'     // P2：叙述性解释、过程思考
  | 'low';       // P3：客套话、环境注入模板

/** 工具输出 */
export interface UirToolOutput {
  /** 文本形式（永远保留；大输出可截断但保留头尾） */
  text: string;
  /** 若输出是结构化数据（JSON/表格），额外保留原始结构 */
  structured?: unknown;
  /** 原始长度（截断时用于告知） */
  originalLength?: number;
  /** 是否被截断 */
  truncated?: boolean;
}

/** 内容块 —— 保留原始交错顺序 */
export type UirBlock =
  | {
      kind: 'text';
      role: 'user' | 'assistant' | 'system' | 'developer';
      text: string;
      tier: ValueTier;
      /** 是否为注入的上下文（环境信息、AGENTS.md 等），摘要时可优先丢弃 */
      injected?: boolean;
    }
  | {
      kind: 'reasoning';
      text: string;
      tier: ValueTier;
      /** 是否加密无法解码 */
      encrypted?: boolean;
      /** 加密时的原始字节数 */
      encryptedBytes?: number;
    }
  | {
      kind: 'tool-call';
      callId: string;
      /** 客户端原始工具名（不做归一化，回写时还原） */
      name: string;
      /** 解析后的参数对象 */
      args: unknown;
      /** 原始参数字符串（保真用） */
      rawArgs?: string;
      tier: ValueTier;
    }
  | {
      kind: 'tool-result';
      callId: string;
      /** 工具名（部分客户端结果里也带） */
      name?: string;
      output: UirToolOutput;
      isError: boolean;
      tier: ValueTier;
    }
  | {
      kind: 'image';
      mime: string;
      /** 引用方式：file 路径 / data URL / 客户端私有 URI */
      ref: string;
      refKind: 'file' | 'data-url' | 'client-uri';
      tier: ValueTier;
    }
  | {
      kind: 'file-change';
      path: string;
      operation: 'add' | 'edit' | 'delete';
      diff?: string;
      tier: ValueTier;
    }
  | {
      kind: 'compaction';
      summary: string;
      /** 被压缩遮蔽的原始序号（用于往返还原） */
      shadowedSeqs?: number[];
      tier: ValueTier;
    };

/** 模型用量 */
export interface UirUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** 一个步骤（一次模型调用 + 其产生的块） */
export interface UirStep {
  index: number;
  reasoning?: string;
  blocks: UirBlock[];
  usage?: UirUsage;
  /** 客户端原始步骤标识（保真用） */
  rawId?: string;
}

/** 一个轮次（一条用户输入 → 完整响应） */
export interface UirTurn {
  index: number;
  startedAt: number;
  endedAt?: number;
  /** 该轮的用户输入（可能有排队多条） */
  userMessages: UirBlock[];
  steps: UirStep[];
  outcome?: {
    status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
    error?: string;
  };
  /** 客户端原始 turn 标识（保真用） */
  rawId?: string;
}

/** 客户端私有记录（保真通道） */
export interface UirOpaque {
  /** 记录种类（客户端自定） */
  kind: string;
  /** 原始位置序号（用于回写时还原顺序） */
  seq: number;
  payload: unknown;
}

/** 统一会话 */
export interface UirSession {
  /** UIR 内部 id（写回目标端时由 writer 生成新 id） */
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;

  /** 来源信息（往返可逆的关键） */
  origin: {
    client: ClientKind;
    originalId: string;
    /** 客户端版本（用于格式兼容判断） */
    clientVersion?: string;
    /** 客户端私有元数据，原样保留 */
    raw?: Record<string, unknown>;
  };

  /** 父会话（子代理场景） */
  parent?: {
    client: ClientKind;
    threadId: string;
    /** 子代理的路径/角色标识 */
    agentPath?: string;
    agentNickname?: string;
  };

  /** 模型与配置快照 */
  model?: {
    provider?: string;
    id?: string;
    variant?: string;
    /** 客户端原始模型标识 */
    rawId?: string;
  };

  /** 轮次序列 */
  turns: UirTurn[];

  /** 客户端独有记录（保真通道，回写时还原） */
  opaque?: UirOpaque[];

  /** 转换过程中产生的警告（中文） */
  warnings?: string[];
}

// ───────────────────────── 适配器接口 ─────────────────────────

/** 适配器能力声明 */
export interface AdapterCapability {
  client: ClientKind;
  label: string;
  canRead: boolean;
  canWrite: boolean;
  supportsSubagent: boolean;
  supportsImage: boolean;
  supportsFileChange: boolean;
  supportsBranching: boolean;
  /** 已知的不可逆转换（往返会丢什么，中文描述） */
  lossyFields: string[];
}

/** 读取选项 */
export interface ReadOptions {
  /** 会话 id（客户端原生 id） */
  sessionId: string;
  /** 读取上限（避免读入超大文件） */
  maxBytes?: number;
  /** 是否包含子代理 */
  includeSubagents?: boolean;
}

/** 读取结果 */
export interface ReadResult {
  session: UirSession;
  warnings: string[];
}

/** 写入选项 */
export interface WriteOptions {
  /** 覆盖标题 */
  title?: string;
  /** 覆盖工作目录 */
  cwd?: string;
  /** 已存在时的行为 */
  mode?: 'skip' | 'overwrite';
  /** 是否备份目标端原有数据 */
  backup?: boolean;
}

/** 写入结果 */
export interface WriteResult {
  ok: boolean;
  /** 目标端生成的会话 id */
  targetId: string;
  /** 落盘位置（文件路径或数据库标识） */
  location: string;
  /** 写入的记录数 */
  records: number;
  warnings: string[];
  error?: { code: string; message: string };
}

/** 会话摘要（列表展示用） */
export interface SessionSummary {
  client: ClientKind;
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  /** 粗略 token 估算（列表阶段可不精确） */
  approxTokens?: number;
  turns?: number;
}

/** 适配器接口 */
export interface SessionAdapter {
  readonly capability: AdapterCapability;
  /** 探测本端是否可用 */
  probe(): { available: boolean; reason?: string };
  /** 列出会话 */
  list(): Promise<SessionSummary[]>;
  /** 读取一个会话为 UIR */
  read(opts: ReadOptions): Promise<ReadResult>;
  /** 把 UIR 写入本端 */
  write(session: UirSession, opts?: WriteOptions): Promise<WriteResult>;
}
