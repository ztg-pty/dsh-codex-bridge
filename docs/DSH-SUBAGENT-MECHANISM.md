# DSH 子智能体机制 实测报告（含对方案的修正）

> 依据：`app.asar` 内 `@deepseek-ai/dsh-subagent` 等 7 个包的真实源码 + 会话格式权威校验器。
> 本节纠正此前方案中的**一处严重错误**和**两处映射选择**。

---

## 一、此前方案的严重错误（必须修正）

### ❌ 错误：`seq` 可以不连续

我在主方案 §0.1 写了"`seq` 不连续（有内部 gap），**不要求连续**"。这是**错的**。

真实校验器 `restoreReleasedV4Artifact()`（`dsh-session-format-v3-to-v4`）原文：

```js
for (const [index, event] of artifact.events.entries()) {
    if (!knownEventTypes.has(event.type) && event["ignorable"] !== true)
        throw new SessionFormatUnsupportedMigrationError(...);
    if (event.seq !== index)
        throw new SessionFormatError(`format v4 event ${index} is not dense`);   // ★ 强制稠密
    ...
}
```

**结论**：`seq` 必须 **从 0 开始严格等于数组下标**，`0,1,2,3,...` 无一跳号。
已有会话文件中看到的 gap（如 `{8}` 直接到 `{19}`）是因为**同 seq 被 `surfaceOp.replace` 替换**或物理层有 run 压缩，逻辑事件数组本身是稠密的。

**对导入器的硬性要求**：生成事件时 `newSeq = index`，**不能**沿用原始 `seq`，也不能从任意数开始。

### ❌ 错误：以为 `xCodex` 需要单独验证（R2 已可结论）

`snapshotSessionFormatHeader()` 原文只校验这几个字段：

```js
inspectSessionFormatVersion(snapshot);                    // version
if (typeof snapshot["id"] !== "string") throw ...;        // id
sessionFormatCount(snapshot["createdAt"], ...);           // createdAt
if (typeof snapshot["isSeeded"] !== "boolean") throw ...; // isSeeded
sessionFormatCount(snapshot["delegationDepth"], ...);     // delegationDepth
```

**未知字段不被拒绝**（只校验上述白名单内的字段）。所以 `xCodex` 可安全放入会话头，**R2 风险降级为低**。
但注意：事件级不同——`assertV4RowAdmission` 对消息 `source.kind` 有白名单约束（见 §三）。

---

## 二、DSH 子智能体的真实架构

### 2.1 包结构

| 包 | 职责 |
|---|---|
| `dsh-subagent` | 委派服务核心：提供方注册表、启动/继续 API、生命周期 |
| `dsh-subagent-spawn-in-process` | 进程内 spawn 后端 |
| `dsh-subagent-fork-in-process` | 进程内 fork 后端（继承父轮次） |
| `dsh-tool-subagent` | 暴露给模型的委派工具 |
| `dsh-tool-subagent-control` | 浏览器侧控制（列举/消息/中断） |
| `dsh-client-ui-subagent` | 子代理 UI 渲染 |
| `dsh-client-ui-settings-subagent` | 设置页 |

### 2.2 父会话里如何记录子智能体

DSH 用**两个专门的事件类型**，全部写在**父会话**里：

#### `subagent/catalog`（父子关系目录，parent-owned）

```js
// 权威 schema（dsh-subagent/lib/types/catalog.js, SUBAGENT_CATALOG_VERSION = 0）
{ version: 0|1, childId, childCreatedAt, mode: 'one-shot',          label? }
{ version: 0|1, childId, childCreatedAt, mode: 'continuable',       label  }  // label 必填
{ version: 2,    childId, childCreatedAt, mode: 'external',         label? }
{ version: 1,    childId, childCreatedAt, mode: 'unknown',          label? }
```

- 会被折叠成父会话的 `subagentCatalog` projection（`stateVersion: 6`）
- `listChildren()` **只读父日志的这个 projection，不读子日志**
- 投影后的视图行：`{ id (=childId), createdAt (=childCreatedAt), mode, label? }`

#### `subagent/descriptor`（子会话内的组成快照，写**子**会话首轮）

```js
// SUBAGENT_DESCRIPTOR_VERSION = 3
// 基础键（one-shot / continuable 共有）
{ version, mode, provider, label }
// continuable 额外键（严格白名单，未知字段会抛错）
{ agentProvider, agentModel, agentReasoningEffort, persona, toolFilter: { allow?, deny? } }
```

**关键约束**：`assertKnownKeys` 会拒绝任何未知字段 → 写 descriptor 时**字段必须精确**，不能加自定义字段。

#### 子会话 `header.parentSession`

DSH 服务端代码里：
```js
const rootId = agent.session.header.parentSession;
```
→ **父子关联的权威字段是 `header.parentSession`**，配合 `header.delegationDepth`（单调深度下限）。

### 2.3 子智能体的消息如何进入父会话（★ 直接决定 `agent_message` 映射）

`dsh-subagent/lib/types/continuation-messages.js` 原文：

```js
function agentMessageSource(sender) {
    return { kind: 'agent-message', form: 'relay', senderSessionId: sender.id };
}
export function createAgentMessage(sender, content) {
    return createUserMessage({
        content: [{ type: 'text', text: `Agent ${sender.id} sent a message: ` }, ...content],
        source: agentMessageSource(sender),
    });
}
```

**这是权威答案**：子代理发给父代理的消息，在 DSH 里就是一条 **`user/message`**，`source` 为：

```json
{"kind":"agent-message","form":"relay","senderSessionId":"<子会话id>"}
```
正文首块固定前缀 `Agent <senderId> sent a message: `。

### 2.4 子代理完成时的父级通知

`createSettlementMessage(childId, terminal, continuable)`，同样是 `user/message`：

| stopReason | 文案 |
|---|---|
| `completed`（可继续） | `Background subagent <id> finished and will do no further work unless you send it more.` |
| `completed`（不可继续） | `Background subagent <id> finished. It cannot receive follow-up messages.` |
| `aborted` | `Background subagent <id> was stopped before it finished.` |
| `max-tokens` | `... ran out of room before it finished.` |
| `refusal` | `... declined the task.` |
| `error` | `... failed before it finished.` |

### 2.5 Agent Teams（另一套，非"子智能体"）

用户已澄清要参考的是**子智能体**。两者区别：

| | 子智能体 (dsh-subagent) | 智能体团队 (agent-team) |
|---|---|---|
| 消息 source.kind | `agent-message` | `team-message`（队列） / `agent-message`+`form:relay`（直接） |
| 关系记录 | `subagent/catalog` 事件 | `agentTeam` projection + `team/*` 事件 |
| 正文前缀 | `Agent <id> sent a message: ` | `Team message <id> from <name>:` |

**映射 Codex `agent_message` 应选子智能体那套**（`kind: 'agent-message'`, `form: 'relay'`）。

---

## 三、消息 source.kind 的合法取值（决定能否安全写入）

v4 校验器 `source()` 原文：

```js
function source(message) {
    const value = message["source"];
    if (!isSessionFormatJsonObject(value) || typeof value["kind"] !== "string"
        || value["kind"].length === 0 || value["kind"] === "plugin")
        throw new SessionFormatError("format v4 message requires a producer-owned source kind");
}
```

规则：
- ✅ `kind` 必须是非空字符串
- ❌ **`kind: 'plugin'` 被硬拒**（v3 遗留写法）
- ✅ 其他 `kind` **只要非空就通过**（原生 source admission 保留未知归属）

从 v3→v4 迁移映射表可见合法 kind 集合包括：
`agent-instructions` `session-reference` `team-message` `goal` `skill-invocation` `skill-catalog` `coordinator` `subagent-report` `subagent-settled` `webhook` `agent-message` `model-selection` `plan-mode` `time-context` `tmux-context` `user-approval` `repeat-tool-reminder` `tool-cordis` `cordis-host-runner` `tool-goal` `tool-jobs` `hooks-codex` `hooks-claude-code` `schedule` `dsh-session-title-llm`，以及 `runtime-context` `compact-checkpoint` `ptc-mode` `compact-basic` `system-prompt`。

**结论**：自定义 `kind`（如 `codex-bridge`）在技术上能通过校验，但**不应滥用**——应优先复用官方语义（`agent-message` / `subagent-report`）。

### 3.1 `tool/result` 的硬约束（`assertV4ToolResultMessage`）

```js
id 必须非空字符串; role === 'tool';
toolCallId 必须非空且 === source.callId;
source.kind 必须 === 'tool';
content 必须是数组，且不能含 type:'tool-result' 的块;
isError 若存在必须是 boolean;
data.error 若存在则 isError 必须为 true;
```

### 3.2 `developer/message` 的硬约束（`assertV4DeveloperData`）

```js
message.role === 'developer'; turn 与 step 必须是正数;
含 tool-addition 块时必须有 headerSeq（且 headerSeq 为非负整数）;
不含 tool-addition 时 **不得出现 headerSeq**;
```

---

## 四、对方案的具体修正清单

| # | 项 | 原方案 | 修正后 |
|---|---|---|---|
| **C1** | `seq` 稠密性 | "不要求连续" | **必须 `seq === index`，从 0 连续** |
| **C2** | `xCodex` 元数据 | 风险 R2（需验证） | **已确认安全**（header 白名单外字段不被拒） |
| **C3** | Codex `agent_message` 映射 | 待定 developer/user | **`user/message` + `source:{kind:'agent-message',form:'relay',senderSessionId}`**，正文前缀 `Agent <id> sent a message: ` |
| **C4** | 子代理关系 | 未涉及 | 导入父会话时，用 `subagent/catalog` 事件声明子代理；`childId` 用 Codex 的 `agent_thread_id` |
| **C5** | 子会话头 | 未涉及 | 若导入子会话，`header.parentSession` = 父 DSH 会话 id，`header.delegationDepth` = `codex.depth` |
| **C6** | 加密占位 | 同意但未定格式 | 见 §五（结构安全，不破坏 JSON） |
| **C7** | `xCodex` 位置 | 会话头 | 确认可行；但 `subagent/descriptor` **不可**加自定义字段（会抛错） |

---

## 五、加密内容占位方案（满足你的要求）

你的要求：**占位、不破坏结构、不产生无效 JSON、导入报告汇总**。

### 5.1 占位规则

```ts
function replaceEncrypted(block: any): any {
  if (block?.type !== 'encrypted_content') return block;
  const len = Buffer.byteLength(block.encrypted_content, 'utf8');
  // ★ 替换成标准 text 块，保持 content 数组同形、字段合法
  return { type: 'text', text: `[加密内容 · 无法解码 · ${len} 字节]` };
}
```

**为什么安全**：
1. 不删除数组元素 → 索引不变
2. 换成语义合法的 `text` 块 → 满足 v4 content 块校验
3. 不引入任何未转义字符 → JSON 永远有效
4. 事件 `type` 不变 → 不会触发 "unknown event type" 拒绝

### 5.2 导入报告结构

```ts
interface ImportReport {
  sessionId: string;
  sourceFile: string;
  ok: boolean;
  stats: {
    turns: number; steps: number;
    messages: number; toolCalls: number;
    encryptedBlocks: number;      // ★ 汇总：共 N 处不可读
    encryptedBytes: number;
  };
  encryptedDetail: Array<{ ordinal: number; author?: string; bytes: number }>;
  warnings: string[];
  droppedFields: string[];
}
```

UI 展示：
```
✅ 已导入：城市建模会话
   轮次 20 · 步骤 87 · 消息 113 · 工具调用 287
   ⚠️ 共 77 处加密内容不可读（合计 1.2 MB）
      · 第 96 行 /root/city_asset_inventory → /root（代理间消息）
      · 第 214 行 spawn_agent 任务内容
```

---

## 六、子智能体导入策略（按你的选择：默认只导父会话）

### 6.1 默认行为（只导父）

```
Codex 父 rollout (01a12682-...)
  ├─ session_meta      → DSH session header（含 xCodex）
  ├─ turn_context      → turn/start + 元数据
  ├─ response_item     → user/assistant/tool 消息
  ├─ agent_message     → user/message (source.kind='agent-message', form='relay')
  ├─ SubAgentActivity  → subagent/catalog 事件（声明子代理存在，但不导子内容）
  └─ FINAL_ANSWER 明文  → 保留为普通消息正文（子代理成果可见）
```

**这样能拿到**：用户完整需求、主代理全部工作、12 个子代理的最终交付内容（明文 33 条那部分）。
**拿不到**：子代理内部执行细节、加密的派活指令。

### 6.2 `subagent/catalog` 生成

```ts
// 从父文件 SubAgentActivity 提取
push('subagent/catalog', {
  version: 0,
  childId: agentThreadId,                 // Codex 的 agent_thread_id
  childCreatedAt: startedAtMs,
  mode: 'one-shot',                       // 我们没有导入子会话 → one-shot
  label: `${agentPath} (${agentNickname})`,
});
```
> 选 `one-shot` 而非 `continuable`：子会话未导入，`continuable` 要求可冷恢复，会失败。

### 6.3 可选：连子会话一起导（后续增强）

若用户勾选"包含子代理"：
- 每个子 rollout 生成一个独立 DSH 会话
- `header.parentSession` = 父 DSH 会话 id
- `header.delegationDepth` = `thread_spawn.depth`
- 子会话首轮写 `subagent/descriptor`（**字段严格按白名单**：`version:3, mode:'one-shot', provider, label`，不写 `agentProvider/agentModel` 等 continuable 专属键）
- 父会话的 catalog 改为 `mode:'continuable'`

---

## 七、最终确认的写入契约（导入器必须遵守）

```ts
// 1. 会话头
header = {
  version: 4,                    // 物理层 version 2，逻辑层 4
  id: 'session-codex-<threadId>',
  createdAt: <ms>,
  isSeeded: false,
  delegationDepth: 0,
  cwd: <codex cwd>,
  agentPreset: 'standard',
  xCodex: {...},                 // ✅ 安全
  // 若为子会话：parentSession: <父dshId>, delegationDepth: <depth>
}

// 2. 事件
events.forEach((e, i) => { e.seq = i; });   // ★★ 必须稠密，从 0 开始

// 3. 每条消息的 source.kind 必须非空且 !== 'plugin'
//    user/message         → {kind:'user'} | {kind:'agent-message',form:'relay',senderSessionId}
//    assistant/message    → {kind:'model',...}
//    tool/result          → {kind:'tool', callId} 且 message.toolCallId === source.callId
//    developer/message    → turn/step 为正数；无 tool-addition 时不得有 headerSeq

// 4. tool/result 的 message.id 必须非空字符串
// 5. content 块禁止出现 type:'tool-result'
// 6. 加密块 → {type:'text', text:'[加密内容 · 无法解码 · N 字节]'}
```

---

## 八、剩余待验证（P0，需在隔离测试会话执行）

| 项 | 验证方法 | 失败回退 |
|---|---|---|
| V1 `seq` 稠密 | 生成 3 事件、seq=0,1,2 的会话，看能否加载 | 已由源码强约束，理论必成 |
| V2 `xCodex` 在 header | 带 xCodex 的会话能否加载+回读 | 移到旁路 `.meta.json` |
| V3 `agent-message` source | 用该 kind 写 user/message，负载是否显示 | 降级为 `kind:'user'` + 正文标注 |
| V4 `subagent/catalog` | 写入后 `listChildren` 是否返回 | 省略 catalog，仅保留正文 |
| V5 `one-shot` 冷恢复行为 | 点击一次性子代理是否会试图恢复子会话 | 若无子会话，UI 是否只读展示 |
