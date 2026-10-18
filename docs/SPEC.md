# Codex ↔ DeepSeek Harness 会话桥接插件 —— 方案（v1，基于真实格式实测）

> 本文全部格式结论来自本机真实数据实测，非推测。证据见 §0.3。
> 沙箱：`pwsh` 需 `danger-full-access`；在 `workspace-write` 下 `grantWrite(D:\UE Save\...)` 报 Win32 5。

---

## 0. 实测证据（方案的全部依据）

### 0.1 DSH 会话真实格式（v4）

文件：`C:\Users\admin\.dsh\sessions\--D-UE~0020Save-fpsys-FPS_Extraction--\<session-id>\session.v4.jsonl.zstd`

**容器形态（关键）**：单个文件 = **顺序追加的多个独立 zstd frame**（实测 4,334,982 字节 / 2305 个 frame / 解压后 3980 行）。
- 不能只解一次：`zstdDecompressSync(整个文件)` 只返回第一帧（214 字节的 header）。
- 正确做法：扫描 `28 B5 2F FD` 魔数切帧，逐帧解压后拼接。
- 增量写 = 每次追加一个 frame。**任意新事件只需追加新 frame 即可**，不需要重写整个文件。

**记录结构**：每行一个 JSON 对象，扁平结构 `{type, seq, time, data, surfaceOp?}`。

实测 35 种 `type`：

| 分类 | type |
|---|---|
| 会话头 | `session` |
| 轮次 | `turn/start` `turn/end` |
| 步骤 | `step/start` `step/end` |
| 消息 | `user/message` `assistant/message` `system/message` `developer/message` |
| 工具 | `tool/call` `tool/result` |
| 请求 | `request/header` `request/context` `assistant/attempt` |
| 状态 | `session/title` `model/selection` `agent/inbox/spliced` |
| 权限 | `permission/preset` `sandbox/mode` `approval/policy` |
| 上下文管理 | `compaction/prune` `compaction/start` `compaction/summary` `compaction/end` |
| 其他 | `command/run` `command/done` `todo/write` `goal/change` `deliverables/presented` `session/end-seed` `job/registered` `job/settled` `session-log-deepseek/delivery-accepted` `session/title-llm-request` |

**核心记录逐字样本**：

```json
{"type":"session","version":4,"id":"session-1e65db66-...","createdAt":1792205205335,"cwd":"D:\\UE Save\\fpsys\\FPS_Extraction","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}

{"type":"turn/start","seq":4,"time":1792205207878,"data":{"turn":1}}

{"type":"user/message","seq":8,"time":1792205207909,"data":{
  "content":[{"type":"text","text":"..."}],
  "source":{"kind":"user","rpcId":"a192d30e-...","clientTimeZone":"Asia/Singapore"},
  "role":"user","id":"22671994-4ce2-4d6b-a6db-1beea399be1e"},"surfaceOp":"append"}

{"type":"assistant/message","seq":19,"time":1792205209673,"data":{
  "turn":1,"step":1,
  "message":{"role":"assistant",
    "content":[{"type":"reasoning","text":"..."},
               {"type":"tool-call","id":"call_00_P7Nov...","name":"read","arguments":"{\"file_path\": \"RTK.md\"}"}],
    "source":{"kind":"model","provider":"deepseek-account","model":"deepseek-flash",
      "replayState":{"response":{"kind":"deepseek-messages","version":1,"model":"deepseek-flash"},
                     "blocks":[{"type":"reasoning","signature":"92522632-..."},{"type":"tool-call"},{"type":"tool-call"}]}},
    "id":"42498cce-..."},
  "usage":{"inputTokens":10820,"outputTokens":238,"cacheReadTokens":896,"cacheWriteTokens":0,"totalTokens":11954},
  "stream":[...]}}

{"type":"tool/call","seq":20,"time":1792205209674,"data":{"turn":1,"step":1,
  "callId":"call_00_P7Nov...","name":"read","arguments":"{\"file_path\": \"RTK.md\"}"}}

{"type":"tool/result","seq":22,"time":1792205238088,"data":{"turn":1,"step":1,
  "message":{"role":"tool",
    "source":{"kind":"tool","callId":"call_00_P7Nov..."},
    "toolCallId":"call_00_P7Nov...",
    "content":[{"type":"text","text":"<path>...</path>..."}],
    "isError":false,"id":"153214cc-..."},
  "meta":{"path":"...","offset":1,"lines":[...]}}}
```

**关键机制**：
- `seq` 单调递增（实测最大 3978），是全局排序键；`seq` 不连续（有内部 gap），但**不要求连续**。
- `time` 为毫秒时间戳。
- `surfaceOp`：`"append"` 或 `{"op":"replace","startSeq":N,"endSeq":M}` —— 后者用于压缩/编辑时遮蔽旧范围（实测 16 处）。
- 工具调用在三处出现：`assistant/message.data.message.content[]` 内的 `tool-call` 块、独立的 `tool/call` 记录、`tool/result` 以 `callId` 关联。**三处必须一致**。
- `compaction/prune.data.shadowedRange` + `shadowedSeqs` 表示这些 seq 被摘要取代（不进模型上下文，但保留在文件里）。
- 投影缓存（只读辅助）：`C:\Users\admin\.dsh\storages\session_projcache\sessions\<session-id>.json`，`version:7`，含 `title`/`tokenUsage`/`turnOutline`/`goal`/`permissions` 等聚合态。**只能读，不能作为写入源**。

### 0.2 Codex rollout 真实格式

**目录布局（扫描目标）**：
```
C:\Users\admin\.codex\sessions\2026\10\16\rollout-<ISO时间>-<thread-id>[_<turn-id>].jsonl       ← 新版明文
C:\Users\admin\.codex\sessions\2026\09\04\rollout-2026-09-04T23-07-20-<id>.jsonl.zst            ← 旧版 zstd
C:\Users\admin\.codex\archived_sessions\...
C:\Users\admin\.codex\session_index.jsonl   ← 轻量索引 {"id","thread_name","updated_at"}
```
实测 140 个文件，最大 105,368,626 字节（明文）。**两种扩展名都要支持**：`.jsonl` 与 `.jsonl.zst`（`.zst` 为单帧 zstd，`zstdDecompressSync` 直接可用）。

**行结构**：`{timestamp, ordinal, type, payload, metadata?}`，`type` ∈ `session_meta` / `turn_context` / `response_item` / `event_msg` / `token_usage_record` / `compacted` / `world_state`。

**核心记录样本**：

```json
{"timestamp":"2026-10-16T06:50:48.986Z","ordinal":4749,"type":"session_meta","payload":{
  "session_id":"01a12f94-...","id":"01a12f94-...","timestamp":"2026-10-16T06:50:48.874Z",
  "cwd":"D:\\UE Save\\fpsys\\FPS_Extraction","runtime_workspace_roots":["..."],
  "originator":"Codex Desktop","cli_version":"0.162.0-alpha.17.2","source":"vscode",
  "thread_source":"user","model_provider":"openai","base_instructions":{"text":"..."},
  "creator_user_id":"user-...","creator_account_id":"..."}}

{"type":"turn_context","payload":{"turn_id":"01a1437a-...","root_turn_id":"01a1437a-...",
  "cwd":"...","model":"workbuddy-cn/deepseek-v4.1-flash","personality":"friendly",
  "approval_policy":"never","sandbox_policy":{"type":"danger-full-access"},
  "collaboration_mode":{"mode":"default","settings":{"model":"...","reasoning_effort":"max"}},
  "timezone":"Asia/Singapore","current_date":"2026-10-16"}}

{"type":"response_item","payload":{"type":"message","id":"msg_d0c3...","role":"assistant",
  "content":[{"type":"output_text","text":"..."}]}}

{"type":"response_item","payload":{"type":"function_call","id":"fc_5182...","name":"exec_command",
  "arguments":"{\"cmd\":\"git ...\",\"shell\":\"powershell\",\"workdir\":\"...\",\"yield_time_ms\":15000}",
  "call_id":"call_00_EJjdED8VdUGo8Fyo2eMx1806"}}

{"type":"response_item","payload":{"type":"function_call_output","id":"fco_...",
  "call_id":"call_00_EJjdED8VdUGo8Fyo2eMx1806",
  "output":"Chunk ID: 4952a5\nWall time: 0.2695 seconds\nProcess exited with code 0\nOriginal token count: 257\nOutput:\n..."}}

{"type":"response_item","payload":{"type":"reasoning","id":"rs_345c...","summary":[{"type":"summary_text","text":"..."}]}}
```

其余 `event_msg`：`task_started` `task_complete` `turn_aborted` `token_count` `thread_settings_applied` `item_completed`。

### 0.3 证据生成脚本

```powershell
# DSH：多 frame 解压
node -e "const z=require('zlib'),fs=require('fs');...扫描 28B52FFD 切帧..."
# 结果：frames ok 2309 / fail 0 / lines 3980 / 类型 35 种
# Codex：直接解压 .zst
# 结果：zstdDecompressSync 单帧成功；明文 .jsonl 2004 行，function_call/output 各 354 对
```

---

## 1. 插件代码结构（遵循 DSH 0.2.1-rc.2）

### 1.1 真实插件形态（实测 `dsh-workbuddy-connect`）

DSH 插件**不是**自定义 manifest，而是一个 **npm 包**，靠 `package.json` 的三个约定接入：

```jsonc
{
  "name": "dsh-codex-bridge",
  "displayName": "Codex 会话桥接",
  "dsh": {
    "bundle":  { "patch": "./cordis.patch.yml" },        // ① 服务端入口注册
    "client":  { "inject": ["@deepseek-ai/dsh-client-ui-settings-plugins", ...],
                 "platform": "web" }                      // ② 浏览器 UI 注入
  }
}
```
- 服务端入口：`main: "lib/index.js"`，导出 `function apply(ctx, config)`。
- 浏览器入口：`exports["./client"]` → `lib/client.js`（带 `module.exports` shim 的单文件 bundle）。
- 注册方式：`cordis.patch.yml` 中 `- insert: [{id, name}]`，由 profile 的 `cordis.patch.yml` 层叠加。
- 版本兼容会被**硬校验**（实测日志原文）：
  > `Plugin dsh-workbuddy-connect@0.7.7 is incompatible with dsh 0.2.1-rc.2: requirements {...}. Running it may cause crashes or data loss.`

### 1.2 目录结构

```
dsh-codex-bridge/
├── package.json                 # 包清单（见 §5）
├── cordis.patch.yml             # 服务端注册：insert {id: codex-bridge, name}
├── tsconfig.json / tsconfig.client.json
├── tsdown.config.ts             # 双入口构建：index(服务端) + client(浏览器)
├── src/
│   ├── index.ts                 # 服务端 apply(ctx)：注册路由 + 设置面 + 日志
│   ├── host/
│   │   ├── routes.ts            # HTTP 路由（/codex-bridge/*）
│   │   ├── scan.ts              # 扫描 .codex/sessions（桌面端）
│   │   ├── import.ts            # 导入编排（Codex → DSH 落盘）
│   │   ├── export.ts            # 导出编排（DSH → JSONL 文件 + 备份）
│   │   ├── backup.ts            # Codex 目录旧 JSONL 备份
│   │   ├── oplog.ts             # 操作日志（导入/导出/备份）
│   │   └── paths.ts             # 路径解析、平台差异
│   ├── convert/                 # ★ 纯函数转换内核（无 IO，可单测）
│   │   ├── codex-reader.ts      # 读 rollout：明文 .jsonl / .jsonl.zst
│   │   ├── dsh-writer.ts        # 读/写 DSH v4 多 frame 会话
│   │   ├── codex2dsh.ts         # Codex → DSH 事件映射
│   │   ├── dsh2codex.ts         # DSH → Codex rollout 映射
│   │   ├── toolmap.ts           # 工具名/参数映射表
│   │   └── sidecar.ts           # 元数据往返（x-codex 附着）
│   ├── io/
│   │   ├── adapter.ts           # IO 适配器接口（桌面/Web 双实现）
│   │   ├── desktop.ts           # 本地目录读写
│   │   └── web.ts               # 上传/下载降级
│   ├── client.ts                # 浏览器入口：设置页 + 列表/勾选 UI
│   ├── client/                  # React 组件
│   │   ├── SettingsPage.tsx     # 插件独立设置页
│   │   ├── ImportDialog.tsx
│   │   ├── ExportDialog.tsx
│   │   └── LogPanel.tsx
│   └── shared/
│       ├── types.ts             # 与 DSH/Codex 结构对应的 TS 类型
│       └── i18n.zh.ts           # 中文文案（含全部错误提示）
├── locale/zh.json, en.json
└── test/
    ├── fixture/                 # 真实脱敏样本（DSH + Codex 各一）
    └── convert.spec.ts          # 往返一致性测试
```

### 1.3 为什么把 `convert/` 单独抽出来

转换内核**不碰文件系统**，只做 `事件数组 ↔ 事件数组`：
- 桌面端与 Web 端复用同一套逻辑，差异只在 `io/adapter.ts`；
- 可对真实 fixture 做往返对比（`dsh → codex → dsh` 结构等价），这是验收核心；
- 出问题时可单独重放，不必启动 UI。

---

## 2. 前端 UI 伪代码

### 2.1 插件列表页 → 独立设置页（要求 1）

```tsx
// SettingsPage.tsx —— 注册到 settings.section，id=plugin-settings 的子槽
export function CodexBridgeSettings() {
  const [env, setEnv] = useState<'desktop'|'web'|null>(null);
  const [log, setLog]     = useState<OpLog[]>([]);

  useEffect(() => { setEnv(detectRuntime()); }, []);  // desktop => 本地目录可用

  return <Card title="Codex 会话桥接">
    <EnvBadge env={env}/>            {/* 桌面端：可扫描本机；Web 端：上传/下载模式 */}
    <Row>
      <Button onClick={() => openImport()}>导入 CodeX 会话</Button>
      <Button onClick={() => openExport()}>导出至 Codex</Button>
    </Row>
    <LogPanel log={log}/>            {/* 关键操作日志，可展开/导出 */}
  </Card>;
}
```

### 2.2 导入流程（功能 1）

```tsx
// ImportDialog.tsx
async function openImport() {
  if (env === 'desktop') {
    setPhase('scanning');
    try {
      const dir = await rpc.scanCodexDir();      // 自动定位 %USERPROFILE%\.codex\sessions
      const list = await rpc.listSessions(dir);  // 全部会话，倒序
      setState({ phase: 'pick', dir, list });
    } catch (e) {
      // 目录找不到 / 权限不足 分别给不同中文提示
      toast.error(mappedMessage(e)); setPhase('error');
    }
  } else {
    setState({ phase: 'upload' });               // Web：不读本地路径，走文件上传
  }
}

// 列表：全部会话 + 倒序 + 关键字/日期筛选；用户手动勾选（默认不勾）
function PickList({ list }) {
  const [kw, setKw] = useState(''); const [range, setRange] = useState(null);
  const [checked, setChecked] = useState<Set<string>>(new Set()); // 空 = 不全选
  const shown = list
    .filter(s => !kw || s.title.includes(kw) || s.cwd.includes(kw))
    .filter(s => !range || inRange(s.updatedAt, range))
    .sort((a, b) => b.updatedAt - a.updatedAt);                    // 时间倒序
  return <>
    <Filters keyword onChange={setKw} dateRange onChange={setRange}/>
    <Table rows={shown} selectable checked onChange={setChecked}/>
    <Footer>
      <span>已选 {checked.size} 个</span>
      <Button disabled={!checked.size} onClick={confirm}>开始导入</Button>
    </Footer>
  </>;
}

async function confirm() {
  setPhase('converting');                          // 逐条进度 + 失败明细
  const res = await rpc.importSessions([...checked]);
  setPhase('done');
  toast.success(`已导入 ${res.ok} 个会话，${res.failed} 个失败`);
  if (res.failed) setFailures(res.failures);       // 每个失败带中文原因 + 可复制详情
}
```

### 2.3 导出流程（功能 2）

```tsx
// ExportDialog.tsx —— 手动勾选，绝不自动全选
async function openExport() {
  const sessions = await rpc.listDshSessions();    // 当前 DSH 全部会话
  setState({ phase: 'pick', sessions, checked: new Set() }); // 初始全不选
}

async function confirmExport() {
  // 二次确认：说明会备份、会写到哪里
  if (!(await confirmDialog(
    '即将导出 N 个会话为 OpenAI 兼容 JSONL。\n' +
    '导出前会自动备份 Codex 目录中的旧版 JSONL。\n继续？'))) return;

  setPhase('exporting');
  const res = await rpc.exportSessions([...checked]);
  setPhase('done');
  setResult(res);   // res: { outDir, files[], backups[] }
}
```

导出完成提示（要求 5，文案固定）：

```
✅ 导出完成：N 个会话

📁 新文件位置：{outDir}
🗂 旧版 JSONL 备份位置：{backupDir}

⚠️ 请手动将新版 JSONL 复制到 Codex 原目录：
   C:\Users\admin\.codex\sessions\YYYY\MM\DD\
   插件不会自动写入 Codex 目录，避免破坏正在进行的会话。
```

### 2.4 错误提示映射（要求：全部中文）

```ts
const ERR_ZH: Record<string, string> = {
  CODEX_DIR_NOT_FOUND: '未找到 Codex 会话目录（预期位置：%USERPROFILE%\\.codex\\sessions）。请确认 Codex 已安装并至少使用过一次。',
  PERMISSION_DENIED:   '权限不足：无法读取该目录。请检查文件夹权限，或以管理员身份运行。',
  FILE_CORRUPTED:      '文件已损坏：{file} 的 zstd 数据无法解压，可能写入中断。该文件已跳过。',
  JSON_PARSE_FAILED:   'JSON 解析失败：{file} 第 {line} 行格式错误。该会话已跳过，其他会话不受影响。',
  DSH_WRITE_FAILED:    '写入 DSH 会话失败：{reason}。原有数据未被修改。',
  SESSION_IN_USE:      '该 DSH 会话正在使用中，无法覆盖导入。请切换到其他会话后重试。',
  NO_SELECTION:        '请至少勾选一个会话。',
  WEB_MODE_LIMIT:      '当前为 Web 模式，浏览器无法直接访问本机目录，请改用上传/下载。',
};
```

---

## 3. 数据转换函数伪代码

### 3.1 读取 Codex（`codex-reader.ts`）

```ts
function readCodexRollout(path): CodexRecord[] {
  const raw = path.endsWith('.zst')
    ? zstd.decompress(fs.readFileSync(path))   // 单帧
    : fs.readFileSync(path, 'utf8');
  const rows = [];
  raw.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { rows.push(JSON.parse(line)); }
    catch { warn('JSON_PARSE_FAILED', { file: path, line: i + 1 }); }  // 单行坏不拖垮整个文件
  });
  if (!rows.length) throw new AppError('FILE_CORRUPTED', { file: path });
  return rows;
}
```

### 3.2 读取 DSH v4（`dsh-writer.ts`）—— 多 frame 分解

```ts
const ZSTD_MAGIC = [0x28, 0xB5, 0x2F, 0xFD];

function readDshSession(file): DshRecord[] {
  const buf = fs.readFileSync(file);
  const cuts = [];
  for (let i = 0; i + 3 < buf.length; i++)
    if (ZSTD_MAGIC.every((b, k) => buf[i + k] === b)) cuts.push(i);
  if (!cuts.length) throw new AppError('FILE_CORRUPTED', { file });

  let text = '';
  for (let i = 0; i < cuts.length; i++) {
    const chunk = buf.subarray(cuts[i], cuts[i + 1] ?? buf.length);
    try { text += zstd.decompress(chunk).toString('utf8'); }
    catch { warn('FRAME_SKIPPED', { file, offset: cuts[i] }); }  // 尾帧写入中断可容忍
  }
  return text.split('\n').filter(Boolean).map(parseJsonSafe);
}

// 追加写：只追加新 frame，绝不重写历史
function appendDshRecords(file, records: DshRecord[]) {
  const text = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(file, zstd.compress(Buffer.from(text)));   // 一个 frame
}
```

### 3.3 Codex → DSH（`codex2dsh.ts`）

```ts
function codexToDsh(recs: CodexRecord[], opts): DshRecord[] {
  const meta = recs.find(r => r.type === 'session_meta').payload;
  const ctxs = recs.filter(r => r.type === 'turn_context').map(r => r.payload);
  const items = recs.filter(r => r.type === 'response_item');

  const out: DshRecord[] = [];
  let seq = 0;
  const push = (type, data, extra = {}) => out.push({ type, seq: ++seq, time: now(), data, ...extra });
  const t0 = Date.parse(meta.timestamp) || Date.now();

  // ① 会话头：id 保留来源信息，避免与既有 DSH 会话冲突
  push('session', {
    type: 'session', version: 4,
    id: `session-codex-${meta.session_id}`,
    createdAt: t0,
    cwd: meta.cwd,
    isSeeded: false, delegationDepth: 0,
    agentPreset: 'standard',
    // ★ 元数据往返：Codex 独有字段整体附着，DSH 忽略未知字段，不破坏原生格式
    xCodex: {
      sessionId: meta.session_id, originator: meta.originator,
      cliVersion: meta.cli_version, source: meta.source,
      modelProvider: meta.model_provider,
      workspaceRoots: meta.runtime_workspace_roots,
      creator: { userId: meta.creator_user_id, accountId: meta.creator_account_id },
      baseInstructionsHash: hash(meta.base_instructions?.text),
      turnContexts: ctxs.map(c => ({
        turnId: c.turn_id, model: c.model, timezone: c.timezone,
        approvalPolicy: c.approval_policy, sandbox: c.sandbox_policy,
        collaboration: c.collaboration_mode,
      })),
      sourceFile: opts.sourcePath, importedAt: Date.now(),
    },
  });

  // ② 按 turn_id 分组（turn_context 是 Codex 的轮次边界）
  const turns = groupByTurn(items, ctxs);
  let turnNo = 0, stepNo = 0;

  for (const turn of turns) {
    turnNo++; stepNo = 0;
    push('turn/start', { turn: turnNo });

    for (const unit of turn.units) {           // unit = 一段 assistant 输出 + 其触发的工具调用
      stepNo++;
      push('step/start', { turn: turnNo, step: stepNo });

      // user 消息
      if (unit.userMessage) {
        push('user/message', {
          content: textBlocks(unit.userMessage.content, 'input_text'),
          role: 'user',
          source: { kind: 'user', origin: 'codex-import' },
          id: uuid(),
        }, { surfaceOp: 'append' });
      }

      // assistant 消息：文本 + reasoning + 工具调用块（三处一致）
      const calls = unit.calls;                // [{callId, name, args}]
      const content = [
        ...(unit.reasoning ? [{ type: 'reasoning', text: reasoningText(unit.reasoning) }] : []),
        ...unit.texts.map(t => ({ type: 'text', text: t })),
        ...calls.map(c => ({ type: 'tool-call', id: c.callId, name: mapToolName(c.name), arguments: mapArgs(c.name, c.arguments) })),
      ];
      push('assistant/message', {
        turn: turnNo, step: stepNo,
        message: {
          role: 'assistant', content,
          // ★ 跨端不可重放采样：不伪造 DSH 原生 replayState
          source: { kind: 'model', provider: `codex:${ctx.model}`,
                    model: ctx.model, imported: true },
          id: uuid(),
        },
        usage: mapUsage(unit.usage),
      }, { surfaceOp: 'append' });

      // 工具调用：每条 function_call → tool/call；对应 output → tool/result
      for (const c of calls) {
        push('tool/call', { turn: turnNo, step: stepNo,
                            callId: c.callId, name: mapToolName(c.name),
                            arguments: mapArgs(c.name, c.arguments) });
        const outRec = unit.outputs.get(c.callId);
        if (outRec) {
          push('tool/result', {
            turn: turnNo, step: stepNo,
            message: {
              role: 'tool',
              source: { kind: 'tool', callId: c.callId },
              toolCallId: c.callId,
              content: [{ type: 'text', text: normalizeOutput(outRec.output) }],
              isError: detectError(outRec.output),
              id: uuid(),
            },
            meta: { importedFrom: 'codex' },
          });
        }
      }

      push('step/end', { turn: turnNo, step: stepNo });
    }

    push('turn/end', { turn: turnNo, reason: { kind: 'completed' } });
  }

  // ③ 模型选择沿用来源模型信息（仅作提示，不覆盖全局配置）
  push('model/selection', { provider: 'codex-import', model: ctxs.at(-1)?.model ?? 'unknown' });

  // ④ ★ 可靠性提醒：插在恢复点（最后一个 turn 之后）
  push('user/message', {
    content: [{ type: 'text', text: RELIABILITY_NOTICE }],
    role: 'user',
    source: { kind: 'plugin', plugin: 'codex-bridge' },
    id: uuid(),
  }, { surfaceOp: 'append' });

  return out;
}

const RELIABILITY_NOTICE =
  '【导入说明】本会话由 Codex 导入。历史中的文件修改类工具结果（apply_patch / 写文件命令）' +
  '可能已与当前磁盘不一致，路径、工作目录、环境变量也可能变化。' +
  '在依赖这些历史结果继续操作前，请重新执行或核对相关文件与命令输出。';
```

### 3.4 工具映射表（`toolmap.ts`）

按**实测已出现的真实工具名**建表，未知工具走通用降级：

```ts
const CODEX_TO_DSH: Record<string, (args) => { name: string; args: string }> = {
  exec_command: a => ({ name: 'pwsh',  args: JSON.stringify({ command: a.cmd }) }),
  shell:        a => ({ name: 'pwsh',  args: JSON.stringify({ command: a.command ?? a.cmd }) }),
  apply_patch:  a => ({ name: 'edit',  args: JSON.stringify({ patch: a.input ?? a.patch }) }),  // 语义降级
  read_file:    a => ({ name: 'read',  args: JSON.stringify(a) }),
  // 其余（view_image → read_image / update_plan → todo_write / …）按实测名补全
};

function mapToolName(codexName: string): string {
  return CODEX_TO_DSH[codexName] ? CODEX_TO_DSH[codexName]({}).name
       : sanitizeName(codexName);          // 未知工具原样保留 + 打 xCodexTool 标记
}
```
> `apply_patch` → `edit` 是**语义降级**（patch 文本 vs 文件路径+替换），必须在 UI/日志里显式标注"该历史调用不可重放"。

### 3.5 DSH → Codex（`dsh2codex.ts`）

```ts
function dshToCodex(records: DshRecord[], opts): string {
  const head = records.find(r => r.type === 'session');
  const lines: CodexLine[] = [];
  let ordinal = 0;
  const emit = (type, payload, ts) => lines.push({ timestamp: ts, ordinal: ordinal++, type, payload });

  const x = head.data.xCodex ?? {};
  // ① session_meta —— 若来源是 Codex 导入，优先还原原始 id/字段，保证往返可逆
  emit('session_meta', {
    session_id: x.sessionId ?? deriveId(head.data.id),
    id:         x.sessionId ?? deriveId(head.data.id),
    timestamp:  iso(head.data.createdAt),
    cwd:        head.data.cwd,
    originator: x.originator ?? 'DSH',
    cli_version: x.cliVersion ?? DSH_VERSION,
    source:     x.source ?? 'dsh',
    model_provider: x.modelProvider ?? 'openai',
    runtime_workspace_roots: x.workspaceRoots ?? [head.data.cwd],
  }, iso(head.data.createdAt));

  // ② 逐事件映射
  let shadowed = new Set();           // compaction/prune 产生的屏蔽集合
  for (const r of records) {
    if (r.type === 'compaction/prune')
      r.data.shadowedSeqs?.forEach(s => shadowed.add(s));

    if (r.type === 'turn/start')      emit('event_msg', { type: 'task_started', turn_id: turnId(r.data.turn) }, ts(r));
    if (r.type === 'turn_context')    emit('turn_context', { turn_id: turnId(r.data.turn), cwd: head.data.cwd, ... }, ts(r));

    if (r.type === 'user/message')
      emit('response_item', { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: joinText(r.data.content) }] }, ts(r));

    if (r.type === 'assistant/message' && !shadowed.has(r.seq))
      emit('response_item', { type: 'message', role: 'assistant',
        content: r.data.message.content
          .filter(b => b.type === 'text')
          .map(b => ({ type: 'output_text', text: b.text })) }, ts(r));

    if (r.type === 'tool/call' && !shadowed.has(r.seq))
      emit('response_item', { type: 'function_call',
        id: `fc_${r.data.callId}`, call_id: r.data.callId,
        name: reverseMapTool(r.data.name), arguments: reverseMapArgs(r.data) }, ts(r));

    if (r.type === 'tool/result' && !shadowed.has(r.seq))
      emit('response_item', { type: 'function_call_output',
        id: `fco_${r.data.message.toolCallId}`, call_id: r.data.message.toolCallId,
        output: joinText(r.data.message.content) }, ts(r));

    if (r.type === 'session/title')
      emit('event_msg', { type: 'thread_name_updated', thread_name: r.data.title }, ts(r));
  }

  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}
```

**OpenAI 兼容性说明**：Codex rollout 的 `response_item` 行与 OpenAI Responses API 的 item 结构同构（`message` / `function_call` / `function_call_output` / `reasoning`），`role`+`content[{type:output_text|input_text}]` 直接对应 Chat/Responses 的 content part。导出即"逐行一个 API item + 元数据字段"。

### 3.6 元数据往返（`sidecar.ts`）—— 你选的"存进 DSH 元数据自定义字段"

```ts
// 往返可逆策略：
//   1. 导入：Codex 独有字段 → DSH session 记录的 xCodex 块（DSH 对未知字段宽容，按实测其解析器只取已知键）
//   2. 导出：优先读 xCodex 还原；没有则按 DSH 字段推导
//   3. 无法表达的字段：写入 oplog 的 droppedFields[]，UI 可见
function attachMeta(dshHead, codexMeta) { dshHead.data.xCodex = codexMeta; }
function restoreMeta(dshHead) { return dshHead.data.xCodex ?? deriveFromDsh(dshHead); }
```
> ⚠️ 这是本方案**唯一需要实测验证**的假设：`xCodex` 属于会话头未知字段，需先在一个测试会话上验证 DSH 能否正常加载（见 §6 风险 R2）。

---

## 4. IO 适配器（桌面 / Web 双环境）

```ts
export interface IOAdapter {
  kind: 'desktop' | 'web';
  scanCodexDir(): Promise<{ dir: string; sessions: SessionSummary[] }>;
  readFile(p: string): Promise<Buffer>;
  writeImport(records: DshRecord[]): Promise<{ path: string }>;   // 落盘为 DSH 会话
  writeExport(files: FileOut[]): Promise<{ outDir: string }>;
  backupOldJsonl(): Promise<{ backupDir: string; files: string[] }>;
}

export function createAdapter(): IOAdapter {
  return isDesktopShell() ? DesktopAdapter : WebAdapter;
}

// DesktopAdapter：直接 fs 读写（经由服务端路由，浏览器不接触本地路径）
// WebAdapter：scanCodexDir 抛 WEB_MODE_LIMIT —— UI 改为 <input type=file multiple>
//             import：上传 .jsonl/.zst → 服务端转换 → 写 DSH 会话
//             export：服务端生成 → 以 Blob 下载；备份改为在下载前把旧文件打包进 zip
```

---

## 5. 插件配置 manifest（`package.json`，依据实测真实插件）

```jsonc
{
  "$schema": "https://json.schemastore.org/package.json",
  "name": "dsh-codex-bridge",
  "displayName": "Codex 会话桥接",          // ← 插件列表页展示名（要求 1）
  "description": "打通 Codex 会话 ↔ DeepSeek Harness，支持双向导入导出。",
  "version": "0.1.0",
  "author": "<you>",
  "keywords": ["dsh-plugin", "deepseek-harness", "codex", "session-import-export"],
  "type": "module",
  "engines": {
    // ★ 实测：0.2.1-rc.2 会做精确版本校验，必须与运行时对齐
    "dsh": "0.2.1-rc.2",
    "node": "^22.19.0 || >=24.0.0"
  },
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".":          { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client":   "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json"
  },
  "files": ["lib", "cordis.patch.yml", "locale", "README.md", "assets"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-ui-settings-plugins",  // 插件列表页/设置页
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-slots",             // slots 注册
        "@deepseek-ai/dsh-client-locale"                // 中文文案
      ],
      "platform": "web"
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-settings": "0.2.1-rc.1",
    "@deepseek-ai/dsh-host-webserver": "0.2.1-rc.1",
    "@deepseek-ai/dsh-atomic-write": "0.2.1-rc.1",
    "@deepseek-ai/dsh-home-paths": "0.2.1-rc.1",
    "@deepseek-ai/dsh-session-log-export": ">=0.2.1-rc.1",  // 会话读取可复用
    "@deepseek-ai/schemastery": "^3.18.2",
    "react": "^18.2.0"
  },
  "icon": "./assets/icon.svg",
  "license": "MIT"
}
```

```yaml
# cordis.patch.yml —— 服务端注册
- insert:
    - id: codex-bridge
      name: dsh-codex-bridge
      config:
        codexHome: ""          # 留空 = 自动探测 %USERPROFILE%\.codex
        outputDir: ""          # 留空 = <dsh-home>/codex-bridge/export
        backupBeforeExport: true
        maxSessionBytes: 268435456   # 超大会话跳过并提示
```

**注册到 profile**（用户侧一次性操作）：
```jsonc
// ~/.dsh/profiles/desktop/package.json
{ "dsh": { "profile": { "bundles": [ "...", "dsh-codex-bridge" ] } } }
```

**版本校验提醒（实测日志）**：插件 peer 依赖版本必须与 DSH 运行时精确匹配，否则安装被拒：
> `dsh: installation rejected: Plugin ... is incompatible with dsh 0.2.1-rc.2 ... Running it may cause crashes or data loss.`

---

## 6. 开发风险点（按严重度排序）

| # | 风险 | 证据/成因 | 应对 |
|---|---|---|---|
| **R1** | **DSH v4 多 frame 格式误读** | 实测 1 个文件 2305 个独立 zstd frame，只解一次仅得 214 字节 header | 必须按魔数切帧；写单测覆盖"截断尾帧""空帧"；追加写只 append 新 frame |
| **R2** | **`xCodex` 自定义字段可能被拒** | DSH 对 session 记录是否严格校验 schema 未知 | 先在一个**丢弃即可的测试会话**里验证；失败则回退为旁路 `codex-bridge.meta.json` |
| **R3** | **伪造 `replayState` 导致崩溃或错误续写** | 实测原生 `source.replayState.blocks[].signature` 与 provider 强绑定（`deepseek-messages`） | 导入记录**绝不伪造** `replayState`；`source.imported=true` 标记；验证 DSH 加载无 signature 的 assistant 消息时的行为 |
| **R4** | **三处工具调用不一致** | 实测同一 callId 出现在 `assistant/message.content`、`tool/call`、`tool/result` | 转换器统一从同一中间模型生成三处；往返测试断言 callId 集合完全相等 |
| **R5** | **`compaction/prune` 语义丢失** | 实测 12 处 prune + 16 处 `surfaceOp.replace`，被遮蔽内容仍在文件里 | 导出时必须读取遮蔽集合过滤；否则压缩历史会二次进上下文 |
| **R6** | **Codex 双扩展名** | 实测同时存在 `.jsonl`(明文,105MB) 与 `.jsonl.zst` | 扫描两者；`.zst` 单帧解压；超大文件流式读，避免 OOM |
| **R7** | **超大会话内存爆掉** | 实测单文件 105MB，解压后可能数倍 | 流式逐行解析；超过 `maxSessionBytes` 直接拒绝并提示，不要静默截断 |
| **R8** | **工具语义降级不可重放** | `exec_command`→`pwsh`、`apply_patch`→`edit` 参数 schema 不同 | 明确标注"不可重放"；在恢复点写可靠性提醒（§3.3 ④）；UI 展示降级清单 |
| **R9** | **Codex 目录存在活跃会话** | 用户可能在会话进行中导出 | 已按你的决策**不写 Codex 目录**，只输出文件 + 备份，彻底规避 |
| **R10** | **版本不兼容被拒装** | 实测 `dsh: installation rejected ... incompatible with dsh 0.2.1-rc.2` | `engines.dsh` 与 peerDependencies 精确对齐；CI 加版本矩阵 |
| **R11** | **Web 端安全边界** | 浏览器拿不到本地路径 | IO 适配器隔离；Web 端**禁止**任何"读本地路径"的失败回退（不强行读） |
| **R12** | **会话 id 冲突** | 导入的 `session-codex-<id>` 可能重复导入 | 导入前去重：已存在则提示"跳过/覆盖/新建副本"，覆盖前备份 |
| **R13** | **敏感信息跨端扩散** | 实测 Codex 会话里出现 sudo 密码明文 | 导入前可选"脱敏扫描"，命中项高亮提示；日志不记录消息正文 |
| **R14** | **损坏文件拖垮整批** | 真实设备存在写入中断 | 单行/单帧/单会话三级隔离，失败项汇总报告，成功项照常导入 |
| **R15** | **插件 UI 槽位竞争** | 实测多个插件抢 `settings.section` 的 `plugin-settings` 容器 | 沿用官方惯用 id `plugin-settings` + 子槽 `plugin-settings.item`，先探测再注册 |

---

## 7. 实施顺序（确认后执行）

1. **P0 格式验证**（0.5 天）：在测试会话上验证 R2 / R3 —— 这是唯一可能推翻设计的点。
2. **P1 转换内核**（1.5 天）：`convert/*` + 真实 fixture 往返测试。
3. **P2 服务端**（1 天）：扫描 / 导入 / 导出 / 备份 / 日志。
4. **P3 前端**（1.5 天）：设置页 + 两个对话框 + 错误提示 + 日志面板。
5. **P4 双环境**（1 天）：Web 上传/下载降级。
6. **P5 验收**（0.5 天）：真实 Codex 会话完整往返。

---

## 8. 待你确认

1. 插件名 `dsh-codex-bridge` / 展示名「Codex 会话桥接」是否合适；
2. `xCodex` 内嵌元数据（R2）是否同意先在测试会话验证再定；
3. P0 是否可以立即开始（会在 `~/.dsh` 下新建一个**隔离测试会话**，不触碰任何现有会话）。
