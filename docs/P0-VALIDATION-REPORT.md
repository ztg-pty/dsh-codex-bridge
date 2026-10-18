# P0 验证报告（用 DSH 真实校验器实测）

> 验证方式：从 `app.asar` 解包出 15,677 个文件（158.4 MB），**直接 import DSH 的真实校验器模块**运行，
> 不是模拟、不是推测。所用模块：`@deepseek-ai/dsh-session-format-v3-to-v4`、`@deepseek-ai/dsh-session`。
> 隔离目录：`C:/Users/admin/p0/e2e-home/`（独立 DSH home，未触碰任何现有会话）。

---

## 一、结论汇总

| 验证项 | 结果 | 说明 |
|---|---|---|
| V1 `seq` 必须稠密 | ✅ 通过 | 跳号/从1起始均被 `is not dense` 拒绝 |
| V2 header 扩展字段 `xCodex` | ❌ **被拒绝** | **推翻了此前的判断，见 §二** |
| V3 `source.kind=agent-message/relay` | ✅ 通过 | 子代理消息映射方案正确 |
| V3 `source.kind=plugin` | ✅ 正确拒绝 | v3 遗留写法被硬拒 |
| V4 `tool/result` 规范 | ✅ 通过 | `message.id` + `toolCallId===source.callId` |
| V5 加密占位为 text 块 | ✅ 通过 | 不破坏结构 |
| V6 `subagent/catalog` one-shot | ✅ 通过 | 子代理目录声明有效 |
| V7 `developer/message` 约束 | ✅ 通过 | 无 tool-addition 时不得带 `headerSeq` |
| **完整真实导入会话** | ✅ **通过** | 13 个事件、含工具调用/子代理消息/加密占位 |
| **端到端写入+读回** | ✅ **通过** | 写入多 frame zstd → 读回 → 往返完全一致 |

---

## 二、⚠️ 重大修正：`xCodex` 不能被放进 header

我在主方案和子智能体报告中都判断「header 未知字段不拒绝，`xCodex` 安全」——**这是错的**。

### 真实校验器（`assertReleasedV4Header`）原文

```js
const required = ["version", "id", "createdAt", "isSeeded", "delegationDepth"];
const allowed = new Set([
  ...required,
  "cwd",
  "parentSession",
  "origin",        // 只允许 "subagent"
  "agentPreset",
]);
const missing = required.find(key => !Object.hasOwn(header, key));
const unexpected = Object.keys(header).find(key => !allowed.has(key));   // ★ 白名单外一律拒绝
if (missing !== undefined) throw new SessionFormatError(`format v4 header lacks required field ${missing}`);
if (unexpected !== undefined) throw new SessionFormatError(`format v4 header has unexpected field ${unexpected}`);
```

**实测输出**：
```
❌ A4 header 加 xCodex：format v4 header has unexpected field xCodex
❌ A5 header 加 xNote：format v4 header has unexpected field xNote
```

我之前只看了 `snapshotSessionFormatHeader()`（那只是快照函数，不做白名单），漏看了真正生效的 `assertReleasedV4Header()`。

### 修正：元数据改存到事件 data 里

事件级**不校验未知字段**（`assertV4RowAdmission` 只校验消息 source、tool/result、developer、retired syntax）。

**实测通过**：
```js
✅ 事件级可携带自定义 data 字段
```

新的元数据落点：

```js
p('model/selection', {
  provider: 'codex-import',
  model: 'gpt-6.1-sol',
  xCodexMeta: {                    // ← 自定义字段，放在事件 data 内
    sessionId: '01a12682-81f1-7de2-b1b4-a42fe207b0f9',
    originator: 'Codex Desktop',
    cliVersion: '0.162.0-alpha.17.2',
    git: { commit_hash: '20cbc379', branch: 'codex/map-recovery-102' },
    threads: [{ id: '01a12685-0dd4', path: '/root/city_code_inventory', depth: 1 }],
  },
});
```

> 若要保持「不污染语义事件」，更干净的做法是新增一个 `ignorable: true` 的自定义事件类型；
> 但需再验证 `ignorable` 对未知 type 的行为，本次未测（列为 P1）。

---

## 三、其他被验证修正的契约

### 3.1 `turn` / `step` 结构必须闭合

测试中出现：`turn/end does not match the open turn with no open step`、`tool/result does not match an open turn and step`。

**正确结构**：
```
turn/start {turn:1}
  step/start {turn:1, step:1}
    user/message / assistant/message / tool/call / tool/result
  step/end {turn:1, step:1}
  ...更多 step
turn/end {turn:1, reason:{kind:'completed'}}
```
任何带 `turn/step` 的消息都必须落在已打开的 step 内。

### 3.2 `surfaceOp` 正确取值

- `'append'`（字符串）✅
- `{ op:'replace', startSeq:N, endSeq:M }` ✅
- `{ op:'append' }` ❌ → `replacement start must be a non-negative safe integer`

### 3.3 `tool/result` 硬约束（实测全部命中）

```
message.id 必须非空字符串
role === 'tool'
toolCallId === source.callId
source.kind === 'tool'
content 必须是数组且不含 type:'tool-result' 块
isError 若存在必须是 boolean
```

### 3.4 `developer/message` 软约束

```
message 必须含 id / role:'developer' / content / source（producer-owned kind）
turn、step 必须为正数
含 tool-addition 块 → 必须有 headerSeq；不含 → 不得出现 headerSeq
```

### 3.5 子会话 header（实测通过）

```js
{ version:4, id:'...', createdAt:T0, isSeeded:false,
  delegationDepth:1,           // 子会话深度
  parentSession:'session-parent-123',   // ✅ 允许
  origin:'subagent',                    // ✅ 仅此值
  cwd:'D:\\...', agentPreset:'standard' }
```

---

## 四、端到端验证（最关键）

```
写入: session-e2e-0001/session.v4.jsonl.zstd  1619 bytes, 10 行, 10 个 zstd frame
读回: 10 条记录
header.id = session-e2e-0001 | version = 4
✅ DSH 真实校验器：通过
✅ 往返完全一致（无损）
事件类型分布: turn/start, step/start, user/message, assistant/message,
              tool/call, tool/result, step/end, subagent/catalog, turn/end
```

这证明：**按修正后的契约生成的会话，能被 DSH 原生校验器完整接受，且往返无损。**

---

## 五、最终写入契约（可直接编码）

```ts
// ── 1. 会话头（严格白名单，多一个字段就报错）──
interface DshHeader {
  version: 4;
  id: string;                 // 'session-codex-<threadId>'
  createdAt: number;          // ms
  isSeeded: false;
  delegationDepth: number;
  cwd?: string;               // 必须绝对路径
  parentSession?: string;     // 子会话时 = 父 DSH 会话 id
  origin?: 'subagent';        // 仅此一个合法值
  agentPreset?: string;
}
// ❌ 禁止：xCodex / xNote / 任何其它自定义字段

// ── 2. 事件 ──
events.forEach((e, i) => { e.seq = i; });        // ★ 必须稠密，从 0 开始
// 每个事件：{ type, seq, time, data, surfaceOp? }

// ── 3. 结构必须闭合 ──
turn/start → step/start → (消息...) → step/end → ... → turn/end

// ── 4. 消息 source.kind ──
// user/message        : {kind:'user'}
//                      | {kind:'agent-message', form:'relay', senderSessionId}
// assistant/message   : {kind:'model', provider, model, imported:true}
// tool/result         : {kind:'tool', callId}  (toolCallId 必须 === callId)
// developer/message   : 任意非空 kind，但必须 ≠ 'plugin'
// ❌ kind:'plugin' 一律拒绝

// ── 5. 元数据 ──
// ❌ 不能放 header
// ✅ 放事件 data（如 model/selection 的 xCodexMeta 字段）

// ── 6. 加密占位 ──
{ type:'text', text:`[加密内容 · 无法解码 · ${n} 字节]` }   // 替换 encrypted_content 块

// ── 7. 子代理 ──
p('subagent/catalog', { version:0, childId, childCreatedAt, mode:'one-shot', label });
```

---

## 六、尚未验证项（P1，不阻塞开发）

| 项 | 说明 |
|---|---|
| `ignorable: true` 自定义事件 | 能否用未知 type + ignorable 承载元数据（更干净） |
| `dsh-session-persistence-jsonl` 真实加载 | 本次用 `restoreReleasedV4Artifact` 校验，未走完整持久化句柄 |
| 子会话冷恢复行为 | `one-shot` catalog 指向不存在的子会话时 UI 表现 |
| `agent/inbox/spliced` 与消息的关系 | 导入是否需要同步写 inbox 事件 |

---

## 七、验证脚本清单

| 文件 | 用途 |
|---|---|
| `p0/extract.cjs` | 从 app.asar 解包 DSH 模块（含正确的 asar 偏移算法） |
| `p0/probe-reject.mjs` | 单点探测 header/source 约束 |
| `p0/p0-suite.mjs` | 14 项契约验证套件 |
| `p0/p0-final.mjs` | 贴近真实导入产物的完整会话验证 |
| `p0/e2e.mjs` | 写入磁盘 → 读回 → 往返一致性 |
| `p0/dsh-root/` | 解包后的 DSH 运行时（可复用） |
