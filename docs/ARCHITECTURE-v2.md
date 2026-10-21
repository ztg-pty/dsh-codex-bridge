# 多端会话互通 + MCP 通用接入 —— 技术方案

> 版本：v2（全部阶段已实现）
> 日期：2026-10-21
> 状态：**Phase 0-3 全部完成**（UIR / 五端适配器 / Token 预算与摘要 / MCP Server / UI）

---

## 实施进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| **Phase 0** | UIR 类型 + 工具函数 | ✅ 完成 |
| **可移植性** | 客户端探测、user_id 三级兜底、平台声明 | ✅ 完成 |
| **Phase 2** | Token 估算 + 四级压缩 + 技术索引 | ✅ 完成（真实 130 万 token 会话验证） |
| **Phase 1** | 五端适配器（DSH/Codex/Zcode/Claude Code/WorkBuddy） | ✅ 完成（20 条转换路径全通） |
| **Phase 3** | MCP Server（stdio + HTTP，6 个工具） | ✅ 完成 |
| **Phase 4** | UI（跨端转换 + 上下文预览）+ 发布 v0.2.0 | ✅ 完成 |

### 已完成模块

```
plugin/src/
├── uir/
│   ├── types.ts              # UIR 类型 + 适配器接口 + 能力声明
│   └── helpers.ts            # 价值分级、特征检测、统计、校验
├── adapters/
│   ├── registry.ts           # 注册表 + 跨端转换 + 损失提示
│   ├── dsh/adapter.ts        # DSH v4 事件流
│   ├── codex/adapter.ts      # rollout + 索引
│   ├── zcode/adapter.ts      # SQLite 三表
│   ├── claude-code/adapter.ts# JSONL + parentUuid
│   └── workbuddy/adapter.ts  # SQLite + JSONL
├── budget/
│   ├── tokens.ts             # Token 估算
│   └── summarize.ts          # 四级压缩 + 技术索引
├── mcp/
│   ├── protocol.ts           # JSON-RPC 2.0 + MCP 方法
│   ├── tools.ts              # 6 个工具
│   └── stdio-entry.ts        # stdio 入口
├── client/
│   ├── SettingsPage.tsx      # 主页（客户端状态 + 三入口）
│   ├── TransferDialog.tsx    # 跨端转换 + 上下文预览
│   ├── ImportDialog.tsx      # Codex → DSH
│   └── ExportDialog.tsx      # DSH → Codex / WorkBuddy
└── host/
    ├── clients.ts            # 五端探测 + 平台声明
    └── routes.ts             # 含 /clients /sessions/all /transfer /context/preview /mcp
```

### 真实验证结果

**五端互通**（20 条路径全部可达）：

```
claude-code    →   -  L4 L2 L3 L4
zcode          → L2   -  L1 L2 L3
dsh            → L2 L3   -  L2 L3
codex          → L2 L3 L1   -  L3
workbuddy      → L2 L3 L1 L2   -
```

**跨端转换实测**：Claude Code → Zcode 成功（3 轮 → 3 轮，自动备份数据库）

**MCP Server 实测**：
- 6 个工具全部注册成功
- `initialize` / `tools/list` / `tools/call` / `ping` 协议正确
- `get_context` 返回带元信息头的压缩上下文

**上下文压缩实测**（130 万 token → 200k 预算）：
- 预算利用率 99.9%
- 报错保留 50%、命令保留 45%
- 技术索引 814 条

---

## 1. 目标

把「两两互转」升级为 **N×N 全互通 + MCP 通用接入**：

```
        ┌──────────────────────────────────────────────┐
        │          UIR  统一会话中间表示                │
        │   （一次建模，所有端复用）                    │
        └──────────────────────────────────────────────┘
             ▲        ▲        ▲        ▲        ▲
      ┌──────┘   ┌────┘   ┌────┘   ┌────┘   ┌────┘
   DSH      Codex    Zcode   Claude Code  WorkBuddy   ← 本地文件适配器（全量历史）
                                                       
                        ＋
                                                       
        ┌──────────────────────────────────────────────┐
        │     MCP Server（通用接入层）                  │
        │  任何支持 MCP 的客户端都能「取上下文/存上下文」│
        └──────────────────────────────────────────────┘
```

**两个独立但互补的通道**：

| 通道 | 能力 | 适用 |
|---|---|---|
| **本地文件适配器** | 读写客户端落盘的完整会话历史 | 已知存储格式的 5 个客户端 |
| **MCP Server** | 通用上下文交换协议 | 任意支持 MCP 的客户端（Cursor、Cline、Continue、自研…） |

> ⚠️ 关键认知：MCP 是**被动**协议——它无法主动读取客户端内部历史，
> 只能接收客户端传来的内容、或返回内容给客户端。所以两条通道必须并存，
> 本地适配器保「全量」，MCP 保「通用」。

---

## 2. 现状盘点

### 已实现（v0.1.0）

| 能力 | 状态 |
|---|---|
| Codex → DSH 导入 | ✅ 已上线 |
| DSH → Codex 导出（含索引注册） | ✅ 已上线 |
| DSH → WorkBuddy 导出 | ✅ 已上线 |
| 插件 UI / 路由 / 日志 / 备份 | ✅ 已上线 |

### 本轮目标

| 能力 | 优先级 |
|---|---|
| Zcode ↔ 全端（转入 + 转出） | P0 |
| WorkBuddy → 全端（转入） | P0 |
| Claude Code ↔ 全端 | P0 |
| MCP Server（取/存上下文） | P1 |
| 200k token 预算 + 智能摘要 | P0（核心） |

---

## 3. 侦察结果：五端存储格式对照

这是本方案的**事实基础**，全部来自本机实测（非推测）。

### 3.1 存储位置与规模

| 客户端 | 根目录 | 会话数 | 存储形态 |
|---|---|---|---|
| **DSH** | `~/.dsh/sessions/` | 452 | 目录树 + 多帧 zstd |
| **Codex** | `~/.codex/sessions/` + `state_5.sqlite` | 151 文件 / 88 thread | 文件 + SQLite 索引 |
| **Zcode** | `~/.zcode/cli/db/db.sqlite` | 126 会话 / 24584 消息 / 107370 part | **纯 SQLite** |
| **Claude Code** | `~/.claude/projects/<cwd编码>/` | 1（本机较少） | JSONL 文件 |
| **WorkBuddy** | `~/.workbuddy-ai/workbuddy.db` + `projects/` | 5 | SQLite + JSONL |

### 3.2 结构对照

#### DSH（v4 事件流）

```
sessions/<projectKey(cwd)>/<sessionId>/session.v4.jsonl.zstd
  ├─ frame0: {"type":"session","version":4,"id","createdAt","cwd","isSeeded","delegationDepth"}
  └─ frameN: {type, seq, time, data, surfaceOp?}
     type ∈ turn/start | step/start | user/message | assistant/message |
            tool/call | tool/result | session/title | subagent/catalog | ...
```

**硬约束**（已踩坑验证）：`seq` 稠密从 0、header 必须含 `type:"session"`、
`assistant/message` 必须含 `stream:[]`、事件不能有 `undefined`、
`session/title` 的 `messageSeqs` 与 `source.kind` 必须匹配。

#### Codex（rollout + SQLite 索引）

```
~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<threadId>.jsonl
  行类型：session_meta | turn_context | response_item | event_msg
  response_item: message | reasoning | function_call | function_call_output | agent_message
  event_msg: task_started | item_completed | task_complete | token_count
state_5.sqlite: threads 表（会话列表数据源）+ session_index.jsonl（CLI resume）
```

**硬约束**：文件名必须 canonical（无毫秒无 Z）、`rollout_path` 用 `\\?\` 长路径、
UI 渲染依赖 `item_completed`、`base_instructions` 必需。

#### Zcode（纯 SQLite，结构最清晰）

```sql
session(id, parent_id, title, directory, time_created, time_updated, ...)   -- 126 行
message(id, session_id, data, sequence)                                    -- 24584 行
part(id, message_id, session_id, data, sequence)                           -- 107370 行
```

`message.data`（JSON）：
```json
{ "role":"user"|"assistant", "time":{"created","completed"},
  "modelID","providerID","mode","agent","path":{"cwd","root"},
  "tokens":{"input","output","reasoning","cache"},
  "semantics":{"origin","kind","uiVisibility","providerVisibility"},
  "anchor":{"turnId","origin"} }
```

`part.data`（JSON，**类型在 data.type 里**）：
| type | 关键字段 |
|---|---|
| `text` | `text`, `time` |
| `reasoning` | `text` |
| `tool` | `callID`, `tool`, `state:{status,input,output,title}`, `time` |
| `step-start` | — |
| `step-finish` | `reason`, `cost`, `tokens` |
| `timeline` | `timelineType`（如 `model_change`）, `fromModel`, `toModel` |
| `file` | `mime`, `url`(`zcode-artifact://`), `metadata` |

**优势**：Zcode 的结构最接近「理想中间表示」，可直接作为 UIR 的参考实现。
**注意**：`session.parent_id` 非空 = 子代理会话（126 中 43 个），与 DSH/Codex 的子代理机制对应。

#### Claude Code（JSONL + parentUuid 链）

```
~/.claude/projects/<cwd编码>/<sessionId>.jsonl
  cwd 编码：D:\UE Save\fpsys\FPS_Extraction → D--UE-Save-fpsys-FPS-Extraction
  行类型：user | assistant | attachment | system | mode | permission-mode |
          file-history-snapshot | last-prompt | cost-state | atis-latch
```

`user` 行：
```json
{ "parentUuid": null, "isSidechain": false, "type":"user",
  "message": {"role":"user","content":"<字符串 或 block 数组>"},
  "uuid", "timestamp"(ISO), "cwd", "sessionId", "version", "gitBranch",
  "isMeta": true|false, "userType":"external", "entrypoint":"cli" }
```

`assistant` 行：
```json
{ "parentUuid": "...", "message": {
    "model":"claude-opus-5-5", "id":"msg_...", "role":"assistant",
    "content":[{"type":"text","text":"..."}, {"type":"tool_use","id","name","input"}],
    "stop_reason","usage":{...} },
  "uuid","timestamp","sessionId", ... }
```

**特点**：`parentUuid` 形成消息树（支持分支/重试）；
`attachment` 行承载环境快照（cwd、git、shell）；`isMeta` 标记非用户真实输入。

#### WorkBuddy（SQLite + JSONL）

```
~/.workbuddy-ai/workbuddy.db
  sessions(id, cwd, user_id, title, status, created_at, updated_at, ...)
  workspaces(path, last_opened_at)
~/.workbuddy-ai/projects/<cwd编码>/<sessionId>.jsonl
  行：session-meta | message | reasoning | function_call |
      function_call_result | ai-title | file-history-snapshot
```

**硬约束**：必须先写库再写文件（否则目录被清理）；目录名盘符小写。

---

## 4. 核心架构

### 4.1 UIR（Unified Intermediate Representation）

一个**以「轮次 + 步骤 + 块」为核心**的规范化模型，参考 Zcode 与 Anthropic Messages 的共识结构：

```typescript
/** 统一会话 */
interface UirSession {
  id: string;                        // UIR 内部 id
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  /** 来源信息（用于往返可逆） */
  origin: {
    client: ClientKind;              // 'dsh' | 'codex' | 'zcode' | 'claude-code' | 'workbuddy' | 'mcp'
    originalId: string;
    /** 客户端私有元数据，原样保留以便无损回写 */
    raw?: Record<string, unknown>;
  };
  /** 父会话（子代理场景） */
  parent?: { clientId: string; threadId: string };
  /** 模型/配置快照 */
  model?: { provider?: string; id?: string; variant?: string };
  /** 事件序列 */
  turns: UirTurn[];
  /** 客户端不认识的原始记录（保真用，回写时还原） */
  opaque?: Array<{ kind: string; payload: unknown; seq: number }>;
}

interface UirTurn {
  index: number;
  startedAt: number;
  endedAt?: number;
  userMessages: UirMessage[];        // 一个 turn 可能有排队的多条输入
  steps: UirStep[];
  outcome?: { status: 'completed' | 'failed' | 'cancelled'; error?: string };
}

interface UirStep {
  index: number;
  reasoning?: UirReasoning;
  blocks: UirBlock[];                // 按原始顺序交错
  usage?: UirUsage;
}

type UirBlock =
  | { kind: 'text';       role: 'user' | 'assistant'; text: string; meta?: ... }
  | { kind: 'reasoning';  text: string; encrypted?: boolean }
  | { kind: 'tool-call';  callId: string; name: string; args: unknown; rawArgs?: string }
  | { kind: 'tool-result'; callId: string; name?: string; output: ToolOutput; isError: boolean }
  | { kind: 'image';      mime: string; ref: string; meta?: ... }
  | { kind: 'file-change'; path: string; diff?: string; operation: 'add'|'edit'|'delete' }
  | { kind: 'compaction'; summary: string; shadowedSeqs?: number[] };

interface ToolOutput {
  /** 结构化文本（永远保留） */
  text: string;
  /** 若输出是结构化数据（JSON/表格），额外保留 */
  structured?: unknown;
  /** 大输出被截断时记录原始长度 */
  truncatedFrom?: number;
}

interface UirUsage {
  input?: number; output?: number; reasoning?: number;
  cacheRead?: number; cacheWrite?: number;
}
```

**设计原则**：

1. **保真优先**：`opaque` 通道存客户端独有记录，回写时原样还原 → 支撑「往返可逆」
2. **顺序保真**：`blocks` 数组保留原始交错顺序（text/reasoning/tool-call 的先后关系是语义）
3. **不丢技术细节**：`tool-call.args` 与 `tool-result.output` 是原始字符串/结构，不做任何改写
4. **可裁剪**：每个 block 带 `weight` 标记，供 Token 预算器决定裁剪优先级

### 4.2 适配器矩阵

```
src/adapters/
├── uir.ts                    # UIR 类型 + 校验 + 工具函数
├── dsh/
│   ├── reader.ts             # DSH v4 → UIR
│   └── writer.ts             # UIR → DSH v4
├── codex/
│   ├── reader.ts             # rollout + threads 表 → UIR
│   └── writer.ts             # UIR → rollout + 索引注册
├── zcode/
│   ├── reader.ts             # db.sqlite → UIR
│   └── writer.ts             # UIR → db.sqlite
├── claude-code/
│   ├── reader.ts             # projects/*.jsonl → UIR
│   └── writer.ts             # UIR → projects/*.jsonl
├── workbuddy/
│   ├── reader.ts             # db + jsonl → UIR      ← 新增（当前只有 writer）
│   └── writer.ts             # UIR → db + jsonl
└── registry.ts               # 客户端发现、能力声明、读写路由
```

**每个适配器声明能力**：

```typescript
interface AdapterCapability {
  client: ClientKind;
  canRead: boolean;
  canWrite: boolean;
  /** 是否支持子代理/分支 */
  supportsSubagent: boolean;
  /** 是否支持图片 */
  supportsImage: boolean;
  /** 是否支持文件变更记录 */
  supportsFileChange: boolean;
  /** 已知的不可逆转换（往返会丢什么） */
  lossyFields: string[];
}
```

UI 据此提示用户「从 X 转到 Y 会丢失：图片、子代理结构…」。

**N×N 互通实现**：`read(clientA) → UIR → write(clientB)`，无需 N² 个转换器。

---

## 5. MCP Server 设计

### 5.1 定位

给**任意支持 MCP 的客户端**提供统一的「会话上下文交换」能力。

典型场景：
- 在 Cursor 里说：「把我在 DSH 里的『城市地图系统』会话上下文拉进来」→ Cursor 调 `get_context` → 拿到压缩后的上下文继续干活
- 在 Claude Code 里说：「把这段对话存到 DSH」→ 调 `push_context` → 写入 DSH

### 5.2 传输与集成方式

| 方式 | 说明 | 优先级 |
|---|---|---|
| **stdio** | 客户端 spawn 我们的进程（最通用） | P1 |
| **HTTP/SSE** | 复用现有插件 webServer（`/mcp`） | P1 |

同时作为 DSH 插件内置（复用现有 `ctx.inject(['webServer'])`）+ 独立 CLI（`dsh-bridge-mcp`）。

> ⚠️ **实测发现**：DSH 内置的 MCP 相关包只有 `@deepseek-ai/dsh-mcp-client`
> 与 `@deepseek-ai/dsh-mcp-resources`——即 **DSH 是 MCP 客户端，不是 MCP 服务端**。
> 所以本项目的 MCP **server 侧需要自行实现**（协议本身是 JSON-RPC 2.0，不复杂：
> `initialize` / `tools/list` / `tools/call` / `resources/list` 等方法）。
> 可参考 DSH 的 `@deepseek-ai/dsh-sdk-jsonrpc-server` 的 JSON-RPC 基础设施实现。


### 5.3 工具定义

```typescript
// ── 发现 ──
list_sessions({
  client?: ClientKind,        // 不传 = 所有端
  cwd?: string,               // 按工作目录过滤
  query?: string,             // 标题/内容关键字
  since?: string,             // ISO 时间
  limit?: number,             // 默认 20
}) → Array<{ client, id, title, cwd, updatedAt, turns, approxTokens }>

// ── 取上下文（核心）──
get_context({
  client: ClientKind,
  sessionId: string,
  /** token 预算，默认 200000，硬上限 200000 */
  budget?: number,
  /** 从哪开始：'all' | 'recent'（默认 recent，保留最近 N 轮 + 早期摘要） */
  scope?: 'all' | 'recent',
  /** 保留策略强度 */
  fidelity?: 'full' | 'balanced' | 'compact',   // 默认 balanced
  /** 关注点：提升匹配内容的保留优先级 */
  focus?: string[],            // 如 ['代码变更', '报错', 'API 参数']
}) → {
  session: { client, id, title, cwd, createdAt, updatedAt },
  /** 压缩后的上下文（markdown，可直接塞进对话） */
  context: string,
  /** 结构化摘要（机器可读） */
  outline: Array<{ turn: number; intent: string; files: string[]; tools: string[] }>,
  stats: {
    originalTokens: number, returnedTokens: number,
    compressionRatio: number,
    dropped: { narrative: number; duplicates: number; reasoning: number },
    preserved: { codeBlocks: number; commands: number; paths: number; errors: number }
  },
  /** 若发生摘要，明确告知 */
  summarized: boolean
}

// ── 存上下文 ──
push_context({
  target: ClientKind,
  title?: string,
  cwd?: string,
  /** 对话内容（客户端把当前对话传进来） */
  messages: Array<{ role: 'user'|'assistant'|'tool'; content: string; ... }>,
  /** 或：从另一端直接转（不经过客户端） */
  source?: { client: ClientKind, sessionId: string },
}) → { ok: true, targetId: string, path: string }

// ── 直接互转（不经客户端）──
transfer_session({
  from: ClientKind, fromId: string,
  to: ClientKind,
  title?: string, cwd?: string,
  budget?: number,
}) → { ok: true, targetId: string, warnings: string[] }

// ── 摘要（单独暴露，便于客户端按需调用）──
summarize_session({
  client: ClientKind, sessionId: string,
  budget?: number, focus?: string[],
}) → { summary: string, stats: {...} }
```

### 5.4 MCP 的安全边界

- 只监听 loopback（HTTP 模式）
- 写操作（`push_context`/`transfer_session`）默认需要显式确认参数 `confirm: true`
- 所有操作写操作日志（复用现有 oplog）
- 不在返回值里泄露绝对路径以外的敏感信息

---

## 6. Token 预算与智能摘要（核心）

### 6.1 问题定义

用户要求：**返还近乎完整的信息，但不超过 200k token；超限自动摘要，但技术细节、具体参数不丢失。**

矛盾点：摘要必然有损。解法是**分级保留**——不是「均匀压缩」，而是「按信息价值选择性丢弃」。

### 6.2 Token 计数

| 方案 | 精度 | 依赖 | 选择 |
|---|---|---|---|
| tiktoken (cl100k/o200k) | 高 | 需要 wasm/包 | 首选 |
| 字符启发式（中英混合） | ±15% | 零依赖 | 兜底 |

实现：`estimateTokens(text)` 优先用 tiktoken，缺失时回退
`cjkCount * 1.0 + latinChars / 4`（中文约 1 token/字，英文约 4 字符/token）。

**安全余量**：预算按 200k 的 **92%** 使用（184k），留出客户端包装开销。

### 6.3 保留优先级（核心算法）

每个 block 在转换时被打上**价值等级**：

| 等级 | 内容 | 处理 |
|---|---|---|
| **P0 永不删** | 代码块、命令、文件路径、参数、错误信息、版本号、配置值、API 签名、数字 | 全保留 |
| **P1 高保留** | 工具调用序列（name+args+result 摘要）、决策理由、约束条件、用户明确要求 | 保留，结果可截断 |
| **P2 可压缩** | 叙述性解释、过程性思考、重复确认 | 压成一句 |
| **P3 可丢弃** | 客套话、寒暄、空转、重复的环境注入 | 丢弃 |

**P0 的结构化提取器**（保证技术细节不丢）：

```typescript
function extractProtected(block: UirBlock): Protected[] {
  // 1. 代码围栏 ```lang\n...\n```
  // 2. 行内代码 `...`
  // 3. 文件路径（Windows/Unix/UNC）
  // 4. 命令行（$ ... / > ... / pwsh -Command ...）
  // 5. 错误信息（Error: / Exception / stack trace）
  // 6. 数字+单位（版本号、端口、超时、大小、坐标）
  // 7. JSON/YAML 片段
  // 8. 工具调用的 args（完整保留）
}
```

这些片段在摘要时**逐字保留**，只有其外围的叙述被压缩。

### 6.4 四级压缩流水线

```
L0 原始  ──(≤184k token)──▶ 直接返回，标注 fidelity:'full'
   │
   │ 超限
   ▼
L1 去冗余  ── 删重复内容、合并连续同类块、剥离环境注入模板
   │         （无损，通常省 15~30%）
   │ 仍超限
   ▼
L2 结构化  ── 每条消息压成 {意图, 关键操作, 结果}，P0 片段逐字保留
   │         工具调用保留 name+args，result 截断到 N 字符（保留头尾）
   │         reasoning 只保留「结论句」（正则提取最后一段判断性语句）
   │ 仍超限
   ▼
L3 骨架    ── 只留：决策链 + 文件变更清单 + 未解决问题 + P0 片段
             早期轮次整体折叠为一句「第 1-12 轮：完成了 X、Y、Z」
```

**关键设计：从最新往回保留。**
近期上下文对「继续干活」最有用，所以：
- 最近 3 轮：**L0 完整**
- 最近 4-10 轮：**L2 结构化**
- 更早：**L3 骨架**（折叠成摘要句）
- 用户消息 + 最终结论：始终保留原文

### 6.5 输出格式

`get_context` 返回的 `context` 是 **markdown**，结构固定便于模型理解：

```markdown
# 会话上下文：设计模块化城市地图系统
> 来源 DSH · 2026-10-17 · 工作目录 D:\UE Save\fpsys\FPS_Extraction
> 原始 412k tokens → 本上下文 178k tokens（保留率 43%）
> 保留：代码块 87 · 命令 152 · 路径 234 · 报错 12

## 概览
（L3 骨架：早期轮次折叠摘要）

## 第 12 轮 · 2026-10-17 14:30
**用户**：继续推进城市地图，补齐立面贴图材质
**助手**：先核对当前工程状态…
  - 🔧 `pwsh` — `Get-ChildItem -Recurse *.umap`
  - ✅ 输出：找到 3 个 umap 文件…
  ```cpp
  // 关键代码逐字保留
  void ACityBuildingActor::OnConstruction(...)
  ```
  - ⚠️ 报错：`error C2065: 'X' : undeclared identifier`

## 第 13 轮（完整）
（最近轮次 L0 原文）
```

### 6.6 预算分配策略

```
总预算 184k
├─ 系统/标题/概览          ≤ 2k    (1%)
├─ 最近 3 轮（L0）         ≤ 90k   (49%)
├─ 中间轮次（L2）          ≤ 60k   (33%)
├─ 早期骨架（L3）          ≤ 12k   (6%)
└─ 安全余量                ~20k   (11%)
```

动态调整：若最近 3 轮不足 90k，剩余预算前移给中间轮次。

---

## 7. 分阶段实施

### Phase 0：UIR 与适配器骨架（预计 2-3 天）

- [ ] 定义 UIR 类型 + 校验（`uir.ts`）
- [ ] 现有 3 端重构为 UIR 适配器（DSH/Codex/WorkBuddy）
- [ ] 建立**往返测试夹具**：`A → UIR → B → UIR` 语义等价断言
- [ ] 能力矩阵与损失提示

**验收**：现有功能行为不变，17 个单测 + 新增往返测试全绿。

### Phase 1：Zcode + Claude Code 适配器（预计 3-4 天）

- [ ] Zcode reader：`session`+`message`+`part` → UIR（含子代理 `parent_id`）
- [ ] Zcode writer：UIR → 三表插入（注意 `sequence` 顺序、`part.data.type`）
- [ ] Claude Code reader：JSONL → UIR（`parentUuid` 链、`attachment` 环境快照）
- [ ] Claude Code writer：UIR → JSONL（保持 `parentUuid` 链）
- [ ] WorkBuddy reader（当前缺失）
- [ ] 全端互转 UI：源/目标下拉 + 损失提示

**验收**：五端两两互转（20 条路径）冒烟通过；真实会话往返无报错。

### Phase 2：Token 预算与摘要引擎（预计 3-4 天）

- [ ] `estimateTokens`（tiktoken + 启发式回退）
- [ ] P0 结构化提取器（8 类正则）
- [ ] L1-L3 压缩流水线
- [ ] 预算分配器（动态前移）
- [ ] 摘要质量回归集（人工标注 10 个会话，检查技术细节保留率）
- [ ] UI 展示压缩统计

**验收**：200k 预算下，技术细节保留率 ≥ 95%（以人工标注集为准）。

### Phase 3：MCP Server（预计 3-4 天）

- [ ] MCP 协议实现（stdio + HTTP/SSE）
- [ ] 6 个工具：`list_sessions` / `get_context` / `push_context` / `transfer_session` / `summarize_session`
- [ ] 接入 DSH 插件路由（`/mcp`）
- [ ] 独立 CLI 包（`dsh-bridge-mcp`）
- [ ] 客户端接入文档（Cursor / Claude Code / Cline 配置示例）

**验收**：在 Claude Code 与 Cursor 中实际调用 `get_context` 成功拿到上下文。

### Phase 4：打磨与发布（预计 2 天）

- [ ] 全端 UI 重构（源/目标选择、进度、结果）
- [ ] 错误信息全覆盖（中文）
- [ ] 文档：架构、适配器开发指南、MCP 接入指南
- [ ] 版本 v0.2.0 发布

**总计：约 13-17 个工作日**（单线程）；若用 Agent Teams 并行，可压到 8-10 天。

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **Zcode db 被运行中的进程锁定** | 写入失败/损坏 | WAL 模式并发写；写入前备份；建议用户关闭 Zcode 或提示重试 |
| **Zcode schema 随版本变化** | 适配器失效 | 启动时读 `schema_migration` 表版本号，不匹配时降级为只读并告警 |
| **Claude Code 用 parentUuid 树结构** | 分支/重试难还原 | UIR 增加 `parentId` 字段；无法还原时线性化并标记 lossy |
| **200k 摘要丢失关键细节** | 用户最在意的点 | P0 逐字保留 + 人工标注回归集 + 返回 `stats` 让用户可见 |
| **MCP 无法读取客户端历史** | 通用性受限 | 文档明确边界：MCP 是「交换」不是「抓取」 |
| **五端写入都可能污染用户数据** | 数据损坏 | 统一 `backup()` 前置；`--dry-run` 预览；操作日志可回滚 |
| **各客户端运行中缓存索引** | 写入后不显示 | 明确「需重启客户端」，或探测进程状态给出提示 |

---

## 9. 验证策略

**分层验证，不靠猜**：

1. **单元测试**：每个适配器的 `read`/`write` + 往返等价断言
2. **格式契约测试**：用真实客户端校验器（如 DSH 的 `restoreReleasedV4Artifact`、
   `Session.create`）验证产物能被目标接受
3. **真实数据冒烟**：每端选 3 个真实会话（小/中/大）做全路径互转
4. **Token 回归集**：10 个人工标注会话，检查 P0 保留率
5. **端到端**：用户在真实客户端里打开、继续对话

> 这次 DSH 导入踩了 8 个格式坑，教训是：**必须用目标端的真实校验器验证，
> 而不是自己写的断言**。方案里每个 writer 都要有「目标端校验器」测试。

---

## 10. 交付物

```
dsh-codex-bridge/
├── plugin/src/
│   ├── uir/                    # 统一中间表示
│   ├── adapters/{dsh,codex,zcode,claude-code,workbuddy}/
│   ├── budget/                 # token 预算与摘要引擎
│   ├── mcp/                    # MCP server
│   └── host/                   # 路由、日志、备份
├── packages/mcp-server/        # 独立 MCP CLI
├── docs/
│   ├── ARCHITECTURE.md         # 本方案
│   ├── ADAPTER-GUIDE.md        # 新端接入指南
│   ├── MCP-INTEGRATION.md      # MCP 接入指南
│   └── FORMAT-MATRIX.md        # 五端格式对照（实测）
└── test/
    ├── fixtures/               # 各端真实会话样本（脱敏）
    ├── roundtrip.spec.ts
    └── budget.spec.ts
```

---

## 11. 需要你确认的决策点

1. **优先级**：Zcode / Claude Code / MCP / 摘要引擎，哪个先做？
   （我建议：UIR 骨架 → Zcode+Claude Code → 摘要 → MCP，因为 MCP 依赖前两者）
2. **Zcode 写入风险**：它的 `db.sqlite` 有 412MB 且正在运行，
   是否接受「写入前强制备份 + 建议关闭 Zcode」？
3. **Claude Code 分支结构**：`parentUuid` 树在跨端时线性化（丢分支），可接受吗？
4. **MCP 形态**：只做 DSH 插件内置，还是同时发布独立 CLI 包？
5. **200k 是硬上限还是默认值**：要不要允许用户按客户端调整（如 Claude 200k、GPT 128k）？
