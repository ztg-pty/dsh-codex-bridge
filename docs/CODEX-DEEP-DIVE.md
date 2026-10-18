# Codex 侧完整探索报告（含子代理、请求链路）

> 全部结论来自本机真实数据实测。样本线程：`codex://threads/01a12682-81f1-7de2-b1b4-a42fe207b0f9`
> 文件：`C:\Users\admin\.codex\sessions\2026\10\10\rollout-2026-10-10T23-50-49-01a12682-81f1-7de2-b1b4-a42fe207b0f9.jsonl`（38,416,699 B / 2,902 行 / 明文 JSONL）

---

## 1. 目录与文件发现

```
C:\Users\admin\.codex\
├── sessions\YYYY\MM\DD\rollout-<ISO时间>-<thread-id>[_<turn-id>].jsonl       ← 新版明文（105 个，最大 105 MB）
│                     ... 同名 .jsonl.zst                                        ← 旧版单帧 zstd（35 个）
├── archived_sessions\                                                          ← 归档
├── session_index.jsonl    {"id","thread_name","updated_at"}                    ← 轻量索引，不含父子关系
├── state_5.sqlite / thread_history_1.sqlite / logs_2.sqlite                   ← 索引库（本次未使用）
└── config.toml, auth.json, .env                                                ← 不在搬运范围（已确认）
```

**实测统计**：140 个 rollout 文件 = 105 明文 + 35 zstd。

**⚠️ 命名陷阱**：文件名里的 ID 是**创建时间戳 + thread id**，`session_meta.session_id` 在子代理文件里指向**父线程**，不是自身。判定"这是谁"必须用 `payload.id`。

---

## 2. 顶层记录结构

每行：`{timestamp, ordinal, type, payload, metadata?}`
- `ordinal`：全局单调序号（样本中跨 compact 后继续递增，实测到 4749+）
- `type` ∈ `session_meta` | `turn_context` | `response_item` | `event_msg` | `token_usage_record` | `compacted` | `world_state` | `inter_agent_communication_metadata`

### 2.1 样本线程记录分布（2,902 行）

| type | 数量 | 说明 |
|---|---|---|
| `response_item/reasoning` | 393 | 推理摘要 |
| `event_msg/token_count` | 337 | 增量 token 统计 |
| `token_usage_record` | 273 | 每次请求完整用量（带 response_id） |
| `event_msg/item_completed` | 864 | UI 事件流（**结构化程度最高**） |
| `response_item/message` | 113 | 对话消息 |
| `response_item/custom_tool_call` | 190 | JS 内联执行工具（`exec`） |
| `response_item/custom_tool_call_output` | 190 | 其输出（数组型） |
| `response_item/function_call` | 97 | 普通函数工具 |
| `response_item/function_call_output` | 97 | 其输出（字符串型） |
| `response_item/agent_message` | 110 | **代理间通信** |
| `inter_agent_communication_metadata` | 110 | 通信元数据（仅 `trigger_turn`） |
| `event_msg/task_started` | 20 | 轮次开始 |
| `event_msg/task_complete` | 15 | 轮次完成 |
| `event_msg/turn_aborted` | 4 | 用户中断 |
| `event_msg/thread_settings_applied` | 34 | 线程设置快照 |
| `world_state` | 32 | 环境状态（AGENTS.md/技能/git/文件系统） |
| `turn_context` | 21 | 每轮上下文 |
| `compacted` | 1 | 压缩后的替换历史 |

---

## 3. 会话元数据（`session_meta`）

```json
{"type":"session_meta","payload":{
  "id":"01a12682-81f1-7de2-b1b4-a42fe207b0f9",
  "session_id":"01a12682-81f1-7de2-b1b4-a42fe207b0f9",   // 子代理中=父线程id
  "timestamp":"2026-10-10T15:50:49.701Z",
  "cwd":"D:\\UE Save\\fpsys\\FPS_Extraction",
  "runtime_workspace_roots":["D:\\UE Save\\fpsys\\FPS_Extraction"],
  "originator":"Codex Desktop",
  "cli_version":"0.162.0-alpha.17.2",
  "source":"vscode",
  "thread_source":"user",
  "model_provider":"openai",
  "base_instructions":{"text":"...21769 chars..."},
  "history_mode":"paginated",
  "context_window":{"window_id":"01a12682-81f2-7642-817f-e152df03158f"},
  "git":{"commit_hash":"20cbc379...","branch":"codex/map-recovery-102"},
  "creator_user_id":"user-wjzdAojIxDvlfPZLRIeBttnP",
  "creator_account_id":"595d00d4-..."
}}
```

---

## 4. 子代理（subagent）—— ★ 本次核心

### 4.1 结论先行：Codex 是"独立线程 + 代理树"模型

与初步猜测相反，**每个子代理都有独立 rollout 文件**，父文件只记录"发生了什么"，不记录子代理内部过程。

```
/root (01a12682-81f1...)                          ← 主线程
├── 01a12685-0dd4...  /root/city_code_inventory   (父文件中出现 9 次 agent_message)
├── 01a12685-3ca5...  /root/city_asset_inventory
├── 01a1292e-fcb0...  /root/city_core_implementation
├── ... 共 12 个实测子线程
└── (每个子线程自身 depth=1，可再派生子代理 depth+1)
```

### 4.2 子代理 `session_meta`（父子关联的全部信息都在这）

```json
{"type":"session_meta","payload":{
  "id":           "01a12685-0dd4-7e31-a8f2-3c04865b6810",   // ★ 子代理自身 id
  "session_id":   "01a12682-81f1-7de2-b1b4-a42fe207b0f9",   // ★ 父线程 id（陷阱：等于父）
  "parent_thread_id": "01a12682-81f1-7de2-b1b4-a42fe207b0f9",
  "thread_source": "subagent",
  "source": {
    "subagent": {
      "thread_spawn": {
        "parent_thread_id": "01a12682-81f1-7de2-b1b4-a42fe207b0f9",
        "depth": 1,
        "agent_path": "/root/city_code_inventory",
        "agent_nickname": "Faraday",
        "agent_role": null
      }
    }
  },
  "agent_nickname": "Faraday",
  "agent_path":   "/root/city_code_inventory",
  "multi_agent_version": "v2",
  "runtime_workspace_roots":[
    "D:\\UE Save\\fpsys\\FPS_Extraction",
    "C:\\Users\\admin\\.codex\\visualizations\\2026\\10\\10\\01a12682-81f1-7de2-b1b4-a42fe207b0f9"
  ]
}}
```

**可用于重建父子关系的三条独立线索**（互为冗余，转换器应全用上）：
1. `payload.parent_thread_id` + `payload.source.subagent.thread_spawn`
2. `payload.session_id`（= 父 id）
3. 父文件中的 `SubAgentActivity.agent_thread_id`

### 4.3 父文件中如何记录子代理：`item_completed/SubAgentActivity`

```json
{"type":"event_msg","payload":{"type":"item_completed","item":{
  "type":"SubAgentActivity",
  "id":"call_2647a0a71c4f44129dfcaa0725934f62",     // = spawn_agent 的 call_id
  "kind":"started",                                   // started / finished
  "agent_thread_id":"01a12685-0dd4-7e31-a8f2-3c04865b6810",  // ★ 指向子文件
  "agent_path":"/root/city_code_inventory"
}}}
```
实测 74 条，对应 12 个 started（+ finished/其他）。

### 4.4 派生子代理的调用：`function_call/spawn_agent`

```json
{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent",
 "arguments":"{\"task_name\":\"city_code_inventory\",\"fork_turns\":\"none\",\"message\":\"gAAAAAB...\"}",
 "call_id":"call_..."}}
```
- `fork_turns`: `"none"` | 数字（实测两种取值）
- **`message` 是加密的**（`gAAAAA...` = Fernet/AES 密文，与 `encrypted_content` 同族），磁盘上不可还原

### 4.5 代理间通信：`response_item/agent_message`

```json
{"type":"response_item","payload":{
  "type":"agent_message",
  "id":"amsg_01a1268a-82b4-...",
  "author":"/root/city_asset_inventory",     // 发送者路径
  "recipient":"/root",                       // 接收者路径
  "content":[
    {"type":"input_text","text":"Message Type: MESSAGE\nTask name: /root\nSender: /root/city_asset_inventory\nPayload:\n"},
    {"type":"encrypted_content","encrypted_content":"gAAAAABqyl-s..."}   // ★ 正文加密
  ]
}}
```

**实测加密比例：110 条中 77 条正文加密（70%），仅 33 条明文。**

明文那 33 条的形状：
```
Message Type: FINAL_ANSWER
Task name: /root
Sender: /root/city_code_inventory
Payload:
只读摸底完成：没有写文件、启动 UE、编译或运行生成脚本……（完整工作汇报）
```
`Message Type` 枚举实测：`FINAL_ANSWER` | `NEW_TASK` | `MESSAGE`
- `NEW_TASK`：父 → 子派活（实测样本中 100% 加密）
- `FINAL_ANSWER`：子 → 父交答卷（33 条明文）
- `MESSAGE`：一般通信（实测样本中加密）

### 4.6 关键：父文件里**已经包含**子代理的明文成果

实测：
- 父文件 `agent_message` = 110 条，子文件 3 条，**ID 零重叠** → 无重复
- 父文件中 `FINAL_ANSWER` 明文 = **33 条**，即子代理的最终汇报**已完整落在父文件里**

**这对插件是决定性结论**：只导入父会话文件，就能拿到"子代理派发了什么（部分）、最终交付了什么（完整）"，但拿不到子代理**内部**执行过程。

### 4.7 加密内容的本机可解性

`encrypted_content` 解密需要 Codex 侧密钥（`auth.json` / 本机环境密钥）。已确认范围外，**插件不尝试解密**，遇到时以占位符呈现：
```
[加密内容 · 无法解码 · 长度 N 字节]
```

---

## 5. 请求链路（"整体如何请求"）

### 5.1 一轮请求的实际构成

CODEX 一次 API 请求的输入 = **拼接后的上下文**，由以下部分按序组成（从 rollout 可完整重建）：

```
┌─ 1. base_instructions（session_meta）
│     "You are Codex, an agent based on GPT-6..."  21,769 字符
├─ 2. developer 消息（response_item/message role=developer）
│     <permissions instructions>  <apps_instructions>
│     <collaboration_mode> …（turn_context.collaboration_mode.settings.developer_instructions）
├─ 3. user 消息（含注入的上下文块）
│     # AGENTS.md instructions for <cwd>
│     <environment_context><cwd>…<shell>…<timezone>…<filesystem>…</environment_context>
├─ 4. world_state（独立记录，提供环境快照）
│     agents_md / host_skills / environments / collaboration_mode
├─ 5. 历史 response_item 序列（按 ordinal）
│     reasoning / message / function_call(+output) / custom_tool_call(+output) / agent_message
└─ 6. 当前轮 user 输入
```

### 5.2 `response_item` 即 OpenAI Responses API item（可直接复刻）

| Codex payload.type | 对应 API item | 关键字段 |
|---|---|---|
| `message` | `message` | `role`, `content[{type: input_text/output_text}]` |
| `reasoning` | `reasoning` | `summary[{type: summary_text, text}]` |
| `function_call` | `function_call` | `id`, `call_id`, `name`, `arguments`(JSON 字符串) |
| `function_call_output` | `function_call_output` | `id`, `call_id`, `output`(字符串) |
| `custom_tool_call` | `custom_tool_call`（非标准） | `id`, `call_id`, `name`, `input`(原始代码), `status` |
| `custom_tool_call_output` | `custom_tool_call_output` | `id`, `call_id`, `output`(**数组**) |
| `agent_message` | 非 OpenAI 标准（Codex 内部协议） | `author`, `recipient`, `content[]` |

### 5.3 `token_usage_record`：每次请求的身份证

```json
{"type":"token_usage_record","payload":{
  "thread_id":"01a12682-...", "turn_id":"01a12683-...",
  "session_id":"01a12682-...", "root_turn_id":"01a12683-...",
  "response_id":"resp_00b7f6ae5d776e56016aca5f1658f88191b14430476ca9ad31",  // ★ API 响应ID
  "usage":{"input_tokens":28051,"cached_input_tokens":8064,"cache_write_input_tokens":0,
           "output_tokens":688,"reasoning_output_tokens":339,"total_tokens":28739},
  "turn_token_usage":{...}, "thread_token_usage":{...}
}}
```
**一次真正的上游请求 = 一条 `token_usage_record`**（带唯一 `response_id`）。这是判断"有没有真的请求模型"的可靠依据。

### 5.4 轮次与中断

```json
{"type":"event_msg","payload":{"type":"task_started",
  "turn_id":"01a12683-...","turn_attribution":{"turn_trigger":"composer","parent_turn_id":null},
  "started_at":1791647513,"model_context_window":828400}}

{"type":"event_msg","payload":{"type":"turn_aborted", ...}}   // 实测 4 次
```
`turn_trigger` = `composer`（用户输入）| 其他（子代理/自动化）

### 5.5 上下文压缩

```json
{"type":"compacted","payload":{
  "message":"",
  "replacement_history":[ {"type":"message","role":"user","content":[{"type":"input_text","text":"<摘要全文>"}]}, ... ]
}}
```
**关键语义**：`compacted` 之后，**该记录之前的 response_item 全部被 `replacement_history` 取代**，不再进入模型上下文。转换器必须识别这个分界点，否则会把已压缩的旧历史重复注入。

### 5.6 `turn_context` 关键字段

`turn_id` `root_turn_id` `cwd` `workspace_roots` `current_date` `timezone` `approval_policy` `sandbox_policy` `permission_profile` `active_permission_profile` `model` `comp_hash` `personality` `collaboration_mode` `multi_agent_version` `effort` `summary`

---

## 6. 两种工具调用形态（必须都支持）

### 6.1 `function_call`（普通工具，`output` 为字符串）
```json
{"payload":{"type":"function_call","id":"fc_5182...","call_id":"call_00_EJjd...",
            "name":"exec_command","arguments":"{\"cmd\":\"git ...\",\"shell\":\"powershell\",\"workdir\":\"...\"}"}}
{"payload":{"type":"function_call_output","id":"fco_...","call_id":"call_00_EJjd...",
            "output":"Chunk ID: 4952a5\nWall time: ...\nProcess exited with code 0\n..."}}
```

### 6.2 `custom_tool_call`（JS 内联执行，`output` 为数组）
```json
{"payload":{"type":"custom_tool_call","id":"ctc_00b7...","status":"completed",
            "call_id":"call_bd62...","name":"exec","input":"const results = await Promise.allSettled([...])"}}
{"payload":{"type":"custom_tool_call_output","id":"ctco_...","call_id":"call_bd62...",
            "output":[{"type":"input_text","text":"Script completed\nWall time 3.0 seconds\nOutput:\n"},
                      {"type":"input_text","text":"Warning: truncated output..."}]}}
```

### 6.3 实测出现的工具名

| 工具 | 形态 | 次数（样本线程） |
|---|---|---|
| `exec` | custom_tool_call | 190 |
| `exec_command` | function_call | 41 |
| `followup_task` | function_call | 22 |
| `spawn_agent` | function_call | 12 |
| `send_message` | function_call | 10 |
| `request_user_input_async` | function_call | 4 |
| `view_image` | function_call | 3 |
| `list_agents` / `sleep` / `shell` | function_call | 2/2/1 |

---

## 7. `item_completed`：结构化事件流（对转换最有价值）

实测 item 类型：

| item.type | 数量 | 可用字段 |
|---|---|---|
| `Reasoning` | 393 | 推理摘要 |
| `CommandExecution` | 220 | `command[]`, `cwd`(file:// URI), `status`, `aggregated_output`, `parsed_cmd[]`, `process_id` |
| `SubAgentActivity` | 74 | `kind`, `agent_thread_id`, `agent_path` |
| `AgentMessage` | 48 | `content[{type:Text}]`, `phase`(commentary/final) |
| `McpToolCall` | 79 | MCP 调用 |
| `UserMessage` | 18 | 用户输入 |
| `ImageView` | 12 | 看图 |
| `FileChange` | 11 | `changes{path:{type:add|update,content}}` |
| `Extension` | 8 | 扩展 |
| `ContextCompaction` | 1 | 压缩事件 |

**`FileChange` 是文件修改的权威记录**（比 `apply_patch` 的参数更可靠，直接给出路径与内容/类型）。

---

## 8. 对插件方案的修正（基于本次探索）

| 原方案假设 | 实测结论 | 修正 |
|---|---|---|
| 只有 `.jsonl.zst` | 明文 105 / zstd 35 | 两种都支持（已覆盖） |
| 子代理是父会话内嵌记录 | **子代理有独立文件** + 父文件有摘要 | 需支持"仅父文件"与"父+子"两种导入模式 |
| `session_id` 唯一标识会话 | 子代理中 `session_id` = 父 id | 必须用 `payload.id` 作为会话主键 |
| 工具只有 `function_call` | 还有 `custom_tool_call`（output 为数组） | 转换器需双路径 + 输出归一化 |
| 无代理通信概念 | `agent_message` + `SubAgentActivity` | 映射为 DSH 的 `agentTeam`/子代理语义，或降级为带标注的用户消息 |
| 压缩无影响 | `compacted.replacement_history` 截断历史 | 导出/导入时必须定位压缩点 |

### 8.1 新增风险点

| # | 风险 | 证据 | 应对 |
|---|---|---|---|
| **R16** | 子代理正文加密不可还原 | 110 条中 77 条 `encrypted_content` | 占位符呈现，不尝试解密；在 UI 明确告知"该部分内容加密，导入后不可读" |
| **R17** | `session_id` 语义歧义 | 子代理 `session_id`=父 id，`id`=自身 | 一律用 `payload.id`；用 `parent_thread_id` 建树 |
| **R18** | `compacted` 分界处理错误 | `replacement_history` 取代之前全部 response_item | 转换前先扫描 `compacted`，以 replacement 为新的历史起点 |
| **R19** | 子代理重复导入 | 本次实测 ID 零重叠（安全），但 `FINAL_ANSWER` 已在父文件 | 默认只导父会话；选"含子代理"时，父文件的 `agent_message` 降级为摘要，不重复展开子文件全文 |
| **R20** | 加密的 `spawn_agent.message` | 派活内容 100% 加密 | 子代理的"任务描述"只能从子文件首条 `agent_message`(NEW_TASK) 或明文 `FINAL_ANSWER` 反推 |

---

## 9. 待你决策

1. **子代理导入策略**：默认只导父会话（拿到完整的用户需求 + 子代理最终交付），还是默认"父 + 全部子代理各成一个 DSH 会话"？后者更完整但会话数会暴增（本例 1 → 13）。
2. **加密内容处理**：同意用占位符 `[加密内容 · 无法解码 · N 字节]` 并在导入报告里汇总"共 N 处加密内容不可读"吗？
3. **`agent_message` 映射**：转成 DSH 的 `developer/message`（保留 author/recipient），还是降级为标注过的 `user/message`？前者语义更准，但 DSH 是否接受非 `tool-registry` 来源的 developer 消息我尚未验证（与 R2 同批验证）。
